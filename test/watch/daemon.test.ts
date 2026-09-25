import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { optionCommands } from "../../src/watch/daemon.ts"
import { claimPidFile, releasePidFile } from "../../src/watch/lock.ts"
import { pickSound, SYSTEM_SOUNDS } from "../../src/watch/sounds.ts"
import { isOff, isOn } from "../../src/watch/state.ts"

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
  test("the option wins when its file exists", () => expect(pickSound("/a.aiff", "/b.m4a", "/sys", exists(["/a.aiff", "/b.m4a"]))).toBe("/a.aiff"))
  test("a missing option file falls to the bundled sound", () => expect(pickSound("/gone", "/b.m4a", "/sys", exists(["/b.m4a"]))).toBe("/b.m4a"))
  test("then the system sound", () => expect(pickSound("", null, SYSTEM_SOUNDS.done, exists([SYSTEM_SOUNDS.done]))).toBe(SYSTEM_SOUNDS.done))
  test("none at all", () => expect(pickSound("", null, "/sys", exists([]))).toBeNull())
})

describe("tmux booleans", () => {
  test("on and off", () => {
    expect(isOn("on") && isOn("1") && isOn("yes")).toBe(true)
    expect(isOff("off") && isOff("0") && isOff(" No ")).toBe(true)
    expect(isOff("") || isOn("")).toBe(false) // unset: enabled, not always
  })
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
