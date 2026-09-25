import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { optionCommands } from "../../src/watch/daemon.ts"
import { claimPidFile, releasePidFile } from "../../src/watch/lock.ts"
import { pickSound, SYSTEM_SOUNDS } from "../../src/watch/sounds.ts"

describe("optionCommands", () => {
  test("sets what differs and unsets windows without agents", () => {
    const current = new Map([
      ["@1", "working"],
      ["@2", "idle"],
      ["@3", "done"],
      ["@4", ""],
    ])
    const wanted = new Map([
      ["@1", "working" as const],
      ["@2", "done" as const],
      ["@5", "blocked" as const],
    ])
    expect(optionCommands(current, wanted)).toEqual([
      ["set-option", "-w", "-t", "@2", "@ai_state", "done"],
      ["set-option", "-w", "-t", "@5", "@ai_state", "blocked"],
      ["set-option", "-uw", "-t", "@3", "@ai_state"],
    ])
  })
})

describe("pickSound", () => {
  const exists = (have: string[]) => (p: string) => have.includes(p)
  test("the custom file wins when it exists", () => expect(pickSound("/a.aiff", "/sys", exists(["/a.aiff", "/sys"]))).toBe("/a.aiff"))
  test("a missing custom file falls to the system sound", () => expect(pickSound("/gone", SYSTEM_SOUNDS.done, exists([SYSTEM_SOUNDS.done]))).toBe(SYSTEM_SOUNDS.done))
  test("none at all", () => expect(pickSound("", "/sys", exists([]))).toBeNull())
})

describe("claimPidFile", () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "senu-lock-"))
    path = join(dir, "sub", "watch.pid")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("claims, then a second claim fails while the holder lives", () => {
    expect(claimPidFile(path, () => true)).toBe(true)
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid))
    expect(claimPidFile(path, () => true)).toBe(false)
  })

  test("takes over a dead holder's file", () => {
    expect(claimPidFile(path, () => true)).toBe(true)
    writeFileSync(path, "999999\n")
    expect(claimPidFile(path, () => false)).toBe(true)
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid))
  })

  test("takes over a garbage file", () => {
    claimPidFile(path, () => true)
    writeFileSync(path, "nonsense")
    expect(claimPidFile(path, () => true)).toBe(true)
  })

  test("the default check sees a dead pid as stale", () => {
    claimPidFile(path, () => true)
    writeFileSync(path, "999999\n") // well above macOS's pid range
    expect(claimPidFile(path)).toBe(true)
  })

  test("release only removes our own file", () => {
    claimPidFile(path, () => true)
    writeFileSync(path, "1\n")
    releasePidFile(path)
    expect(readFileSync(path, "utf8")).toBe("1\n")
    writeFileSync(path, `${process.pid}\n`)
    releasePidFile(path)
    expect(() => readFileSync(path)).toThrow()
  })
})
