import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { optionCommands } from "../../src/watch/daemon.ts"
import { claimPidFile, releasePidFile } from "../../src/watch/lock.ts"
import { defaultSoundFile, pickSound, playbackCommand, playerCommand, powershellString, SYSTEM_SOUNDS } from "../../src/watch/sounds.ts"

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

describe("portable sound playback", () => {
  test("generates distinct PCM WAV chimes that survive a second lookup", () => {
    const dir = mkdtempSync(join(tmpdir(), "senu-chimes-"))
    try {
      const done = defaultSoundFile("done", dir)
      const request = defaultSoundFile("request", dir)
      const a = readFileSync(done)
      const b = readFileSync(request)
      expect(a.subarray(0, 4).toString()).toBe("RIFF")
      expect(a.subarray(8, 16).toString()).toBe("WAVEfmt ")
      expect(a.readUInt32LE(40)).toBe(a.length - 44)
      expect(a.equals(b)).toBe(false)
      expect(defaultSoundFile("done", dir)).toBe(done)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("chooses an available player for each platform", () => {
    const available = (names: string[]) => (name: string) => names.includes(name) ? `/bin/${name}` : null
    expect(playerCommand("/tone.wav", "darwin", available(["afplay"]))).toEqual(["afplay", "/tone.wav"])
    expect(playerCommand("/tone.wav", "linux", available(["paplay", "aplay"]))).toEqual(["paplay", "/tone.wav"])
    expect(playerCommand("/tone.wav", "linux", available(["ffplay"]))).toEqual(["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "/tone.wav"])
    expect(playerCommand("C:\\tone.wav", "win32", available(["powershell.exe"]))?.[0]).toBe("powershell.exe")
    expect(playerCommand("C:\\tone.m4a", "win32", available(["powershell.exe"]))?.[4]).toContain("System.Windows.Media.MediaPlayer")
    expect(playerCommand("/tone.m4a", "linux", available(["paplay", "ffplay"]), false)?.[0]).toBe("ffplay")
    const wsl = playerCommand("/tone.m4a", "linux", available(["powershell.exe", "wslpath", "paplay"]), true)
    expect(wsl?.[0]).toBe("powershell.exe")
    expect(wsl?.at(-1)).toContain("System.Windows.Media.MediaPlayer")
    expect(wsl?.[4]).toContain("$env:SENU_SOUND_FILE")
    expect(powershellString("C:\\User's Files\\tone.wav")).toBe("'C:\\User''s Files\\tone.wav'")
    expect(playbackCommand("/tone.m4a", "linux", available(["powershell.exe", "wslpath", "ffplay"]), true, () => "C:\\User's Files\\tone.m4a")?.[4]).toContain("[uri]'C:\\User''s Files\\tone.m4a'")
    expect(playbackCommand("/tone.m4a", "linux", available(["powershell.exe", "wslpath", "ffplay"]), true, () => null)?.[0]).toBe("ffplay")
    expect(playerCommand("/tone.wav", "linux", available(["paplay"]), true)).toEqual(["paplay", "/tone.wav"])
    expect(playerCommand("/tone.wav", "linux", available([]))).toBeNull()
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
