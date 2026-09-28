import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { claimPidFile, isWatcher } from "~/watch/lock.ts"
import { binaryChanged, handOff, HandOffSchedule, isReplacement } from "~/watch/rebuild.ts"

function stamps(...seq: (string | null)[]) {
  let i = 0
  return () => seq[Math.min(i++, seq.length - 1)]!
}

describe("binaryChanged", () => {
  test("stays false while the binary is untouched", () => {
    const changed = binaryChanged("senu", stamps("a"))
    expect([changed(), changed(), changed()]).toEqual([false, false, false])
  })

  test("waits for the new binary to hold still for one check", () => {
    const changed = binaryChanged("senu", stamps("a", "b", "b"))
    expect([changed(), changed()]).toEqual([false, true])
  })

  test("ignores a build still being written", () => {
    const changed = binaryChanged("senu", stamps("a", "b", "c", "d", "d"))
    expect([changed(), changed(), changed(), changed()]).toEqual([false, false, false, true])
  })

  test("ignores a binary that is missing mid-build", () => {
    const changed = binaryChanged("senu", stamps("a", null, null, "b", "b"))
    expect([changed(), changed(), changed(), changed()]).toEqual([false, false, false, true])
  })

  test("ignores a change that is reverted before it settles", () => {
    const changed = binaryChanged("senu", stamps("a", "b", "a", "a"))
    expect([changed(), changed(), changed()]).toEqual([false, false, false])
  })

  test("reports each new build once", () => {
    const changed = binaryChanged("senu", stamps("a", "b", "b", "b", "c", "c"))
    expect([changed(), changed(), changed(), changed(), changed()]).toEqual([
      false,
      true,
      false,
      false,
      true,
    ])
  })
})

describe("HandOffSchedule", () => {
  test("is due at once after a build, then after each failure", () => {
    const s = new HandOffSchedule([5, 30])
    expect(s.due(0)).toBe(false)
    s.rebuilt(100)
    expect(s.due(100)).toBe(true)
    s.failed(100)
    expect([s.due(104), s.due(105)]).toEqual([false, true])
    s.failed(105)
    expect([s.due(134), s.due(135)]).toEqual([false, true])
  })

  test("gives up after the last retry until the next build", () => {
    const s = new HandOffSchedule([5])
    s.rebuilt(0)
    s.failed(0)
    s.failed(5)
    expect(s.due(1_000_000)).toBe(false)
    s.rebuilt(2_000_000)
    expect(s.due(2_000_000)).toBe(true)
  })
})

describe("isReplacement", () => {
  const live = () => true
  test("a live watcher that took the lock", () => expect(isReplacement(42, null, live)).toBe(true))
  test("not the new watcher that was stopped, even while it lingers", () =>
    expect(isReplacement(42, 42, live)).toBe(false))
  test("another live watcher still counts after stopping ours", () =>
    expect(isReplacement(43, 42, live)).toBe(true))
  test("not a dead holder", () => expect(isReplacement(42, null, () => false)).toBe(false))
  test("not an empty lock", () => expect(isReplacement(0, null, live)).toBe(false))
  test("never this watcher itself", () =>
    expect(isReplacement(process.pid, null, live)).toBe(false))
})

describe("handOff", () => {
  let dir: string
  let lock: string
  const children: number[] = []
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const holder = () => Number(readFileSync(lock, "utf8").trim())
  // `watch` in the arguments lets the lock's ps check accept the child as a watcher.
  const writesPid = (path: string) => ["sh", "-c", 'echo $$ > "$0"; sleep 5', path, "watch"]
  const child = () => Number(readFileSync(join(dir, "child"), "utf8").trim())

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "senu-handoff-"))
    lock = join(dir, "watch.pid")
    expect(claimPidFile(lock)).toBe(true)
  })

  afterEach(() => {
    for (const pid of children.splice(0))
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  })

  test("hands the lock to a watcher that claims it", async () => {
    expect((await handOff(lock, writesPid(lock))).replaced).toBe(true)
    children.push(holder())
    expect(holder()).not.toBe(process.pid)
  })

  test("keeps the lock when the new watcher exits at once", async () => {
    expect(await handOff(lock, ["sh", "-c", "exit 1"])).toEqual({ replaced: false, killed: null })
    expect(holder()).toBe(process.pid)
  })

  test("keeps the lock when the binary cannot start", async () => {
    expect((await handOff(lock, [join(dir, "missing")])).replaced).toBe(false)
    expect(holder()).toBe(process.pid)
  })

  test("stops a watcher that never claims the lock and takes it back", async () => {
    const result = await handOff(lock, writesPid(join(dir, "child")), { timeout: 200 })
    const pid = child()
    children.push(pid)
    expect(result).toEqual({ replaced: false, killed: pid })
    expect(holder()).toBe(process.pid)
    expect(alive(pid)).toBe(false)
  })

  test("kills a new watcher that ignores the stop and takes the lock back", async () => {
    const ignoresStop = [
      "sh",
      "-c",
      'trap "" TERM; echo $$ > "$0"; sleep 5',
      join(dir, "child"),
      "watch",
    ]
    expect((await handOff(lock, ignoresStop, { timeout: 200 })).replaced).toBe(false)
    const pid = child()
    children.push(pid)
    expect(holder()).toBe(process.pid)
    expect(alive(pid)).toBe(false)
  })

  test("does not mistake itself for the replacement when the lock cannot be released", async () => {
    chmodSync(dir, 0o555)
    expect((await handOff(lock, ["sh", "-c", "exit 0"], { timeout: 200 })).replaced).toBe(false)
    expect(holder()).toBe(process.pid)
  })

  test("a retry does not defer to a watcher an earlier attempt stopped", async () => {
    const lingering = Bun.spawn(["sh", "-c", "sleep 5; true", "watch"], { detached: true })
    children.push(lingering.pid)
    writeFileSync(lock, `${lingering.pid}\n`)
    chmodSync(dir, 0o555)
    const holderAlive = (pid: number) => pid !== lingering.pid && isWatcher(pid)
    const result = await handOff(lock, ["sh", "-c", "exit 0"], { holderAlive, timeout: 200 })
    expect(result.replaced).toBe(false)
  })

  test("defers to another live watcher that took the lock", async () => {
    const other = Bun.spawn(["sh", "-c", "sleep 5; true", "watch"], { detached: true })
    children.push(other.pid)
    expect((await handOff(lock, ["sh", "-c", `echo ${other.pid} > "$0"`, lock])).replaced).toBe(
      true,
    )
    expect(holder()).toBe(other.pid)
  })

  test("keeps running when the lock cannot be claimed and no watcher holds it", async () => {
    expect((await handOff(lock, ["chmod", "555", dir])).replaced).toBe(false)
  })

  test("a stop during the wait wins over the handoff", async () => {
    const stop = new AbortController()
    setTimeout(() => stop.abort(), 200)
    expect(
      (await handOff(lock, writesPid(join(dir, "child")), { signal: stop.signal })).replaced,
    ).toBe(false)
    const pid = child()
    children.push(pid)
    await Bun.sleep(100)
    expect(alive(pid)).toBe(false)
  })
})
