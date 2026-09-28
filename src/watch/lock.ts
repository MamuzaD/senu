import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { dirname } from "node:path"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function isWatcher(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return false
  try {
    const out = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="]).stdout.toString()
    return /\bwatch\b/.test(out)
  } catch {
    // If ps is unavailable, keep the live PID's lock to avoid starting a second watcher.
    return true
  }
}

function olderThan(path: string, ms: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > ms
  } catch {
    return true
  }
}

/** Claims the lock atomically; returns false while another live watcher owns it. */
export function claimPidFile(
  path: string,
  holderAlive: (pid: number) => boolean = isWatcher,
): boolean {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx")
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      return true
    } catch {
      let pid: number
      try {
        pid = Number(readFileSync(path, "utf8").trim())
      } catch {
        continue
      }
      // Another process may have created the file but not written its PID yet.
      if (pid === 0 && !olderThan(path, 2000)) return false
      if (pid > 0 && holderAlive(pid)) return false
      try {
        unlinkSync(path)
      } catch {}
    }
  }
  return false
}

/** Removes the lock only if its PID still belongs to this process. */
export function releasePidFile(path: string) {
  try {
    if (Number(readFileSync(path, "utf8").trim()) === process.pid) unlinkSync(path)
  } catch {}
}

/** The PID in the lock, or 0 when it is missing or unreadable. */
export function pidFileHolder(path: string): number {
  try {
    return Number(readFileSync(path, "utf8").trim())
  } catch {
    return 0
  }
}

/**
 * Whether another live watcher now holds the lock. A lock that is free again is
 * reclaimed; one that can be neither claimed nor attributed, or that errors
 * (e.g. its directory is gone and cannot be recreated), is not counted as lost.
 */
export function lockLost(path: string, holderAlive: (pid: number) => boolean = isWatcher): boolean {
  try {
    if (pidFileHolder(path) === process.pid || claimPidFile(path, holderAlive)) return false
  } catch {
    return false
  }
  const holder = pidFileHolder(path)
  return holder > 0 && holderAlive(holder)
}
