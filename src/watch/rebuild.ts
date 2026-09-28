import { statSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"

import { claimPidFile, isWatcher, pidFileHolder, releasePidFile } from "./lock.ts"

const HANDOFF_MS = 3000
const RETRY_MS = [5_000, 30_000, 120_000]

function stampOf(path: string): string | null {
  try {
    const s = statSync(path)
    return `${s.ino}:${s.mtimeMs}:${s.size}`
  } catch {
    return null
  }
}

/**
 * Returns a check that is true once per change to `path`, after the new file
 * has held still between two calls. That skips a build mid-write, though a
 * writer that pauses longer than the interval could still be caught.
 */
export function binaryChanged(path: string, stamp = stampOf): () => boolean {
  let start = stamp(path)
  let last = start
  return () => {
    const now = stamp(path)
    const settled = now !== null && now === last
    last = now
    if (!settled || now === start) return false
    start = now
    return true
  }
}

/**
 * When to hand off to a rebuilt binary: at once, again after each failure on
 * the retry schedule, then not until the next build.
 */
export class HandOffSchedule {
  private at: number | null = null
  private failures = 0
  private delays: number[]

  constructor(delays = RETRY_MS) {
    this.delays = delays
  }

  rebuilt(now: number) {
    this.at = now
    this.failures = 0
  }

  due(now: number): boolean {
    return this.at !== null && now >= this.at
  }

  failed(now: number) {
    const wait = this.delays[this.failures++]
    this.at = wait === undefined ? null : now + wait
  }
}

/**
 * Releases `lock` to a watcher started with `command`. Returns true once
 * another live watcher holds the lock. If the new one exits, or has not claimed
 * the lock by `timeout`, it is killed, the lock is taken back and this returns
 * false so the caller keeps running. An abort during the wait does the same.
 * A new watcher that was killed never counts, even if it claimed the lock in
 * the moment before it was signalled; its PID comes back as `killed` so later
 * lock checks, and `holderAlive` on later attempts, can ignore it while it lingers.
 */
export async function handOff(
  lock: string,
  command: string[],
  {
    signal,
    timeout = HANDOFF_MS,
    holderAlive = isWatcher,
  }: { signal?: AbortSignal; timeout?: number; holderAlive?: (pid: number) => boolean } = {},
): Promise<{ replaced: boolean; killed: number | null }> {
  releasePidFile(lock)
  let child: Bun.Subprocess | undefined
  let exited = false
  try {
    child = Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"], detached: true })
    child.unref()
    void child.exited.then(() => (exited = true))
  } catch {
    exited = true
  }
  const deadline = Date.now() + timeout
  // oxlint-disable-next-line no-unmodified-loop-condition
  while (!exited && !signal?.aborted && pidFileHolder(lock) !== child?.pid && Date.now() < deadline)
    await delay(50)
  let killed: number | null = null
  if (child && !exited && (signal?.aborted || pidFileHolder(lock) !== child.pid)) {
    killed = child.pid
    await killAndAwait(child)
  }
  const kept = { replaced: false, killed }
  if (signal?.aborted) return kept
  const alive = (pid: number) => pid !== killed && holderAlive(pid)
  try {
    if (claimPidFile(lock, alive)) return kept
  } catch {
    return kept
  }
  return { replaced: isReplacement(pidFileHolder(lock), killed, alive), killed }
}

async function killAndAwait(child: Bun.Subprocess) {
  const exited = child.exited.then(() => true)
  child.kill("SIGTERM")
  if (await Promise.race([exited, delay(1000, false)])) return
  child.kill("SIGKILL")
  await Promise.race([exited, delay(1000)])
}

/**
 * Whether `holder` took over: a live watcher other than this process (whose PID
 * stays in the lock if it could not be released), and not the new one this
 * process killed, which may still hold the lock if it outlived SIGKILL's wait.
 */
export function isReplacement(
  holder: number,
  killedPid: number | null,
  holderAlive: (pid: number) => boolean = isWatcher,
): boolean {
  return holder !== process.pid && holder !== killedPid && holder > 0 && holderAlive(holder)
}
