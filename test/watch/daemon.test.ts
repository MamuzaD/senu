import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { optionCommands } from "~/watch/daemon.ts"
import { claimPidFile, releasePidFile } from "~/watch/lock.ts"
import {
  defaultSoundFile,
  pickSound,
  playbackCommand,
  playerCommand,
  powershellString,
  SYSTEM_SOUNDS,
} from "~/watch/sounds.ts"

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
  test("the custom file wins when it exists", () =>
    expect(pickSound("/a.aiff", "/sys", exists(["/a.aiff", "/sys"]))).toBe("/a.aiff"))
  test("a missing custom file falls to the system sound", () =>
    expect(pickSound("/gone", SYSTEM_SOUNDS.done, exists([SYSTEM_SOUNDS.done]))).toBe(
      SYSTEM_SOUNDS.done,
    ))
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
    const available = (names: string[]) => (name: string) =>
      names.includes(name) ? `/bin/${name}` : null
    expect(playerCommand("/tone.wav", "darwin", available(["afplay"]))).toEqual([
      "afplay",
      "/tone.wav",
    ])
    expect(playerCommand("/tone.wav", "linux", available(["paplay", "aplay"]))).toEqual([
      "paplay",
      "/tone.wav",
    ])
    expect(playerCommand("/tone.wav", "linux", available(["ffplay"]))).toEqual([
      "ffplay",
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "quiet",
      "/tone.wav",
    ])
    expect(playerCommand("C:\\tone.wav", "win32", available(["powershell.exe"]))?.[0]).toBe(
      "powershell.exe",
    )
    expect(playerCommand("C:\\tone.m4a", "win32", available(["powershell.exe"]))?.[4]).toContain(
      "System.Windows.Media.MediaPlayer",
    )
    expect(playerCommand("/tone.m4a", "linux", available(["paplay", "ffplay"]), false)?.[0]).toBe(
      "ffplay",
    )
    const wsl = playerCommand(
      "/tone.m4a",
      "linux",
      available(["powershell.exe", "wslpath", "paplay"]),
      true,
    )
    expect(wsl?.[0]).toBe("powershell.exe")
    expect(wsl?.at(-1)).toContain("System.Windows.Media.MediaPlayer")
    expect(wsl?.[4]).toContain("$env:SENU_SOUND_FILE")
    expect(powershellString("C:\\User's Files\\tone.wav")).toBe("'C:\\User''s Files\\tone.wav'")
    expect(
      playbackCommand(
        "/tone.m4a",
        "linux",
        available(["powershell.exe", "wslpath", "ffplay"]),
        true,
        () => "C:\\User's Files\\tone.m4a",
      )?.[4],
    ).toContain("[uri]'C:\\User''s Files\\tone.m4a'")
    expect(
      playbackCommand(
        "/tone.m4a",
        "linux",
        available(["powershell.exe", "wslpath", "ffplay"]),
        true,
        () => null,
      )?.[0],
    ).toBe("ffplay")
    expect(playerCommand("/tone.wav", "linux", available(["paplay"]), true)).toEqual([
      "paplay",
      "/tone.wav",
    ])
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
    writeFileSync(path, "999999\n")
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

describe("tmux calls per poll", () => {
  const working = new URL("../fixtures/detect/claude-working-screen.screen", import.meta.url)
    .pathname
  let dir: string
  const setPanes = (ids: string[]) => writeFileSync(join(dir, "panes.json"), JSON.stringify(ids))
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "senu-fake-tmux-"))
    setPanes(["%1"])
    writeFileSync(
      join(dir, "tmux"),
      `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
const dir = ${JSON.stringify(dir)}
const args = process.argv.slice(2)
appendFileSync(dir + "/calls", args.join(" ") + "\\n")
const panes: string[] = JSON.parse(readFileSync(dir + "/panes.json", "utf8"))
const statePath = dir + "/state.json"
const state: Record<string, string> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}
const win = (id: string) => "@" + id.slice(1)
const cmds: string[][] = [[]]
for (const a of args) a === ";" ? cmds.push([]) : cmds.at(-1)!.push(a)
let out = ""
let code = 0
for (const c of cmds) {
  const target = c[c.indexOf("-t") + 1] ?? ""
  if (c[0] === "list-panes")
    for (const id of panes)
      out += [id, "123", "claude", "1", "main", "0", win(id), "0", "agent", "1", "0", state[win(id)] ?? "", "host", "host", "host"].join("\\x1f") + "\\n"
  // Like tmux: display-message tolerates a gone target, capture-pane fails and stops the chain.
  else if (c[0] === "capture-pane" && !panes.includes(target)) { code = 1; break }
  else if (c[0] === "display-message") out += c.at(-1) + "\\n"
  else if (c[0] === "capture-pane") out += readFileSync(${JSON.stringify(working)}, "utf8")
  else if (c[0] === "set-option" && c.includes("@ai_state")) {
    if (existsSync(dir + "/fail-writes")) { code = 1; break }
    state[target] = c.at(-1)!
  }
}
writeFileSync(statePath, JSON.stringify(state))
process.stdout.write(out)
process.exit(code)
`,
    )
    chmodSync(join(dir, "tmux"), 0o755)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // A child process, since Bun resolves binaries with the PATH it started with.
  const polls = (between: Record<number, string[]>, count: number, dry = false, hook = "") => {
    const script = join(dir, "poll.ts")
    const daemon = new URL("../../src/watch/daemon.ts", import.meta.url).pathname
    writeFileSync(
      script,
      `import { appendFileSync, rmSync, writeFileSync } from "node:fs"
import { Watcher } from ${JSON.stringify(daemon)}
const between: Record<number, string[]> = ${JSON.stringify(between)}
const w = new Watcher()
for (let i = 0; i < ${count}; i++) {
  if (between[i]) writeFileSync(${JSON.stringify(join(dir, "panes.json"))}, JSON.stringify(between[i]))
  ${hook}
  await w.tick(true, i * 1000, ${dry}).catch(() => {})
  appendFileSync(${JSON.stringify(join(dir, "calls"))}, "--\\n")
}`,
    )
    const run = Bun.spawnSync(["bun", script], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMUX: "", TMUX_TMPDIR: dir },
      stderr: "pipe",
    })
    if (run.exitCode !== 0) throw new Error(run.stderr.toString())
    const byPoll = readFileSync(join(dir, "calls"), "utf8").split("--\n").slice(0, count)
    return byPoll.map((p) => p.trim().split("\n").filter(Boolean))
  }
  const state = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))

  test("a steady poll is one tmux call: heartbeat, listing, and last poll's agents", () => {
    const [first, second] = polls({}, 2)
    expect(first![0]).toMatch(/^set-option -g @ai_watch_heartbeat \d+ ; list-panes -a -F \S+$/)
    expect(first![1]).toContain("capture-pane -p -t %1")
    expect(first![2]).toBe("set-option -w -t @1 @ai_state working")
    expect(first).toHaveLength(3)
    expect(second).toHaveLength(1)
    expect(second![0]).toMatch(
      /^set-option -g @ai_watch_heartbeat \d+ ; list-panes -a -F \S+ ; display-message -p -t %1 .* ; capture-pane -p -t %1$/,
    )
  })

  test("a new agent pane is captured and classified in the poll that lists it", () => {
    const [, second] = polls({ 1: ["%1", "%2"] }, 2)
    expect(second![0]).toContain("capture-pane -p -t %1")
    expect(second![0]).not.toContain("%2")
    expect(second![1]).toContain("capture-pane -p -t %2")
    expect(state()["@2"]).toBe("working")
  })

  test("a pane gone since last poll does not cost the others their screens that poll", () => {
    const [, second] = polls({ 0: ["%1", "%2", "%3"], 1: ["%2", "%3"] }, 2)
    expect(second![0]).toMatch(/^set-option -g @ai_watch_heartbeat .* capture-pane -p -t %1 ; /)
    expect(second!.slice(1).join("\n")).toContain("capture-pane -p -t %2")
    expect(second!.slice(1).join("\n")).toContain("capture-pane -p -t %3")
    expect(state()).toEqual({ "@1": "working", "@2": "working", "@3": "working" })
  })

  test("after a poll that failed partway, the next one sends no heartbeat", () => {
    const hook = `w.realIdentify ??= w.identified.identify.bind(w.identified)
  w.identified.identify = i === 0 ? () => Promise.reject(new Error("boom")) : w.realIdentify`
    const [first, second, third] = polls({}, 3, false, hook)
    expect(first![0]).toMatch(/^set-option -g @ai_watch_heartbeat /)
    expect(first).toHaveLength(1)
    expect(second![0]).toMatch(/^list-panes -a -F /)
    expect(third![0]).toMatch(/^set-option -g @ai_watch_heartbeat /)
  })

  test("failed state writes keep the heartbeat back until a poll's writes land", () => {
    const flag = JSON.stringify(join(dir, "fail-writes"))
    const hook = `if (i === 0) writeFileSync(${flag}, "")
  if (i === 2) rmSync(${flag})`
    const [first, second, third, fourth] = polls({}, 4, false, hook)
    expect(first![0]).toMatch(/^set-option -g @ai_watch_heartbeat /)
    expect(second![0]).toMatch(/^list-panes /)
    expect(third![0]).toMatch(/^list-panes /)
    expect(third!.at(-1)).toBe("set-option -w -t @1 @ai_state working")
    expect(fourth![0]).toMatch(/^set-option -g @ai_watch_heartbeat /)
    expect(state()).toEqual({ "@1": "working" })
  })

  test("a poll with many agents keeps each tmux call under tmux's command size limit", () => {
    const ids = Array.from({ length: 150 }, (_, i) => `%${i + 1}`)
    const [first, second] = polls({ 0: ids }, 2)
    const writes = first!.filter((call) => call.includes("@ai_state working"))
    expect(writes.map((call) => call.split("@ai_state").length - 1)).toEqual([100, 50])
    const count = (call: string) => call.split("capture-pane").length - 1
    expect(count(second![0]!)).toBe(100)
    expect(count(second![1]!)).toBe(50)
    expect(second).toHaveLength(2)
    expect(Object.keys(state())).toHaveLength(150)
  })

  test("a dry poll writes nothing", () => {
    const calls = polls({}, 2, true)
    expect(calls.flat().some((c) => c.includes("set-option"))).toBe(false)
    expect(calls[1]).toHaveLength(1)
  })
})
