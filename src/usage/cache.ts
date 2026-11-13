import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import type { Profile as AnyProfile, UsageProfile as Profile } from "~/config.ts"
import { cacheDir, selfCommand } from "~/paths.ts"

import { fetchClaude } from "./claude.ts"
import { fetchCodex } from "./codex.ts"
import { nowSeconds, type Snapshot } from "./types.ts"

const FRESH_TTL_SECONDS: Record<Profile["kind"], number> = { codex: 60, claude: 300 }
const STALE_MAX_AGE_SECONDS = 15 * 60
const LOCK_TTL_SECONDS = 15

const usageDir = join(cacheDir, "usage")

interface CacheEntry {
  cachedAt: number
  /** ms time of the last failed fetch that left these limits in place. */
  failedAt?: number
  snapshot: Snapshot
}

export const profileKey = (p: AnyProfile) => `${p.kind}-${p.name.replace(/[^\w.-]/g, "_")}`
const cachePath = (p: Profile) => join(usageDir, `${profileKey(p)}.json`)
const lockPath = (p: Profile) => join(usageDir, `${profileKey(p)}.lock`)

export function readCache(p: Profile): CacheEntry | null {
  try {
    return JSON.parse(readFileSync(cachePath(p), "utf8"))
  } catch {
    return null
  }
}

/** Stores a snapshot and returns what's now cached: a failed fetch keeps the last good limits, marked with its error. */
function writeCache(p: Profile, snapshot: Snapshot): Snapshot {
  const last = readCache(p)
  const entry: CacheEntry =
    !snapshot.ok && last?.snapshot.ok
      ? {
          cachedAt: last.cachedAt,
          failedAt: Date.now(),
          snapshot: { ...last.snapshot, refreshError: snapshot.error },
        }
      : { cachedAt: nowSeconds(), snapshot }
  mkdirSync(usageDir, { recursive: true })
  const tmp = `${cachePath(p)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(entry))
  renameSync(tmp, cachePath(p))
  return entry.snapshot
}

export function claimLockFile(path: string, ttlSeconds = LOCK_TTL_SECONDS): boolean {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, "wx"))
      return true
    } catch {
      try {
        const ageMs = Date.now() - statSync(path).mtimeMs
        if (ageMs < ttlSeconds * 1000) return false
        unlinkSync(path)
      } catch {}
    }
  }
  return false
}

export function releaseLockFile(path: string) {
  try {
    unlinkSync(path)
  } catch {}
}

export const claimLock = (p: Profile) => claimLockFile(lockPath(p))
export const releaseLock = (p: Profile) => releaseLockFile(lockPath(p))

function fetchProfile(p: Profile): Promise<Snapshot> {
  return p.kind === "codex" ? fetchCodex(p.home) : fetchClaude(p.home)
}

/** Fetches and caches a snapshot. The caller must already hold the lock; it's released here. */
export async function refreshLocked(p: Profile): Promise<Snapshot> {
  const release = () => releaseLock(p)
  process.once("exit", release)
  try {
    return writeCache(p, await fetchProfile(p))
  } finally {
    process.off("exit", release)
    releaseLock(p)
  }
}

/** Starts a detached refresh unless one already holds the profile's lock. */
export function spawnBackgroundRefresh(p: Profile) {
  if (!claimLock(p)) return
  try {
    const child = Bun.spawn([...selfCommand(), "vision", "refresh", profileKey(p), "--locked"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    })
    child.unref()
  } catch {
    releaseLock(p)
  }
}

/** Returns fresh cached data, serves stale data while refreshing, or awaits a fetch when expired. */
export async function getSnapshot(p: Profile): Promise<Snapshot> {
  const cached = readCache(p)
  const age = cached ? nowSeconds() - cached.cachedAt : Infinity

  if (cached && age <= FRESH_TTL_SECONDS[p.kind]) return cached.snapshot
  if (cached && age <= STALE_MAX_AGE_SECONDS) {
    spawnBackgroundRefresh(p)
    return cached.snapshot
  }

  if (claimLock(p)) return refreshLocked(p)
  return writeCache(p, await fetchProfile(p))
}
