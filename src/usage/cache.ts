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
  /** The last failed fetch that left these limits in place: its ms time and error. */
  failedAt?: number
  failure?: string | null
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

/** The entry's limits, marked with the error of a failed fetch that couldn't replace them. */
export const withFailure = (entry: CacheEntry): Snapshot =>
  entry.failedAt == null
    ? entry.snapshot
    : { ...entry.snapshot, refreshError: entry.failure ?? null }

/** Stores a fetch and returns what to show for it: a failed one leaves the last good limits cached and notes its error beside them. */
function writeCache(p: Profile, snapshot: Snapshot): Snapshot {
  const last = readCache(p)
  const entry: CacheEntry =
    !snapshot.ok && last?.snapshot.ok
      ? { ...last, failedAt: Date.now(), failure: snapshot.error }
      : { cachedAt: nowSeconds(), snapshot }
  mkdirSync(usageDir, { recursive: true })
  const tmp = `${cachePath(p)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(entry))
  renameSync(tmp, cachePath(p))
  return withFailure(entry)
}

const REFRESH_COOLDOWN_MS = 10_000

/** True when the profile was fetched, or failed to fetch, too recently to ask again. */
export function fetchedLately(p: Profile): boolean {
  const entry = readCache(p)
  return (
    !!entry &&
    Date.now() - Math.max(entry.cachedAt * 1000, entry.failedAt ?? 0) < REFRESH_COOLDOWN_MS
  )
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
