import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs"
import { dirname } from "node:path"

/**
 * The single-instance guard: a pid file per tmux server. tmux.conf starts the
 * daemon on every config reload, so a second start must see the first and quit.
 * A pid file left by a daemon that died (or whose pid now belongs to something
 * else) is taken over.
 */

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A live process that is a `senu watch`, not some unrelated process that inherited the pid. */
export function isWatcher(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return false
  try {
    const out = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="]).stdout.toString()
    return /\bwatch\b/.test(out)
  } catch {
    return true // can't tell; assume it's ours rather than run twice
  }
}

function olderThan(path: string, ms: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > ms
  } catch {
    return true
  }
}

/** Atomically claims `path` for this process. False if a live watcher holds it. */
export function claimPidFile(path: string, holderAlive: (pid: number) => boolean = isWatcher): boolean {
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
        continue // vanished between open and read; retry
      }
      // an empty file is a claim still being written, unless it's been empty for a while
      if (pid === 0 && !olderThan(path, 2000)) return false
      if (pid > 0 && holderAlive(pid)) return false
      try {
        unlinkSync(path)
      } catch {}
    }
  }
  return false
}

/** Removes the pid file if it's still ours. */
export function releasePidFile(path: string) {
  try {
    if (Number(readFileSync(path, "utf8").trim()) === process.pid) unlinkSync(path)
  } catch {}
}
