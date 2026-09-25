import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { UsageProfile } from "../config.ts"
import { cacheDir, selfCommand } from "../paths.ts"
import { fetchClaude } from "./claude.ts"
import { fetchCodex } from "./codex.ts"
import { nowSeconds, type Snapshot } from "./types.ts"

/** Serve from cache without refreshing while younger than this. */
const FRESH_TTL_SECONDS: Record<UsageProfile["kind"], number> = { codex: 60, claude: 300 }
/** Past the fresh TTL but younger than this, serve stale and refresh in the background. */
const STALE_MAX_AGE_SECONDS = 15 * 60
/** A refresh lock older than this is treated as abandoned. */
const LOCK_TTL_SECONDS = 15

const usageDir = join(cacheDir, "usage")

interface CacheEntry {
  cachedAt: number
  snapshot: Snapshot
}

export const profileKey = (p: UsageProfile) => `${p.kind}-${p.name.replace(/[^\w.-]/g, "_")}`
const cachePath = (p: UsageProfile) => join(usageDir, `${profileKey(p)}.json`)
const lockPath = (p: UsageProfile) => join(usageDir, `${profileKey(p)}.lock`)

export function readCache(p: UsageProfile): CacheEntry | null {
  try {
    return JSON.parse(readFileSync(cachePath(p), "utf8"))
  } catch {
    return null
  }
}

function writeCache(p: UsageProfile, snapshot: Snapshot) {
  // keep good data over a failed refresh; it ages out to a synchronous fetch instead
  if (!snapshot.ok && readCache(p)?.snapshot.ok) return
  mkdirSync(usageDir, { recursive: true })
  const entry: CacheEntry = { cachedAt: nowSeconds(), snapshot }
  const tmp = `${cachePath(p)}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(entry))
  renameSync(tmp, cachePath(p))
}

/** Atomically claims the refresh lock. False if another refresh holds a live one. */
export function claimLock(p: UsageProfile): boolean {
  mkdirSync(usageDir, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lockPath(p), "wx"))
      return true
    } catch {
      try {
        const ageMs = Date.now() - statSync(lockPath(p)).mtimeMs
        if (ageMs < LOCK_TTL_SECONDS * 1000) return false
        unlinkSync(lockPath(p))
      } catch {
        // lock vanished between open and stat; retry
      }
    }
  }
  return false
}

export function releaseLock(p: UsageProfile) {
  try {
    unlinkSync(lockPath(p))
  } catch {}
}

function fetchProfile(p: UsageProfile): Promise<Snapshot> {
  return p.kind === "codex" ? fetchCodex(p.home) : fetchClaude(p.home)
}

/** Fetches and caches a snapshot. The caller must already hold the lock; it's released here. */
export async function refreshLocked(p: UsageProfile): Promise<Snapshot> {
  const release = () => releaseLock(p)
  process.once("exit", release)
  try {
    const snapshot = await fetchProfile(p)
    writeCache(p, snapshot)
    return snapshot
  } finally {
    process.off("exit", release)
    releaseLock(p)
  }
}

/**
 * Spawns a detached `senu vision refresh` that outlives the popup. The lock is
 * claimed here and handed to the child with --locked, so the child doesn't
 * try to re-claim a lock its parent already holds.
 */
function spawnBackgroundRefresh(p: UsageProfile) {
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

/** Stale-while-revalidate read of a profile's snapshot. */
export async function getSnapshot(p: UsageProfile): Promise<Snapshot> {
  const cached = readCache(p)
  const age = cached ? nowSeconds() - cached.cachedAt : Infinity

  if (cached && age <= FRESH_TTL_SECONDS[p.kind]) return cached.snapshot
  if (cached && age <= STALE_MAX_AGE_SECONDS) {
    spawnBackgroundRefresh(p)
    return cached.snapshot
  }

  // nothing usable cached; block on a fetch so there's something to show
  if (claimLock(p)) return refreshLocked(p)
  const snapshot = await fetchProfile(p)
  writeCache(p, snapshot)
  return snapshot
}
