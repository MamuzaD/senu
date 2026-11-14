import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { ConfigError, hasUsage, loadConfig, type ThreadsConfig } from "~/config.ts"

const write = (text: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "senu-")), "config.toml")
  writeFileSync(path, text)
  return path
}

describe("[usage] config", () => {
  test("rejects a usage that isn't a table", () => {
    for (const value of ["5", '"claude"', "true", "[]"]) {
      expect(() => loadConfig(write(`usage = ${value}\n`))).toThrow(ConfigError)
      expect(() => loadConfig(write(`usage = ${value}\n`))).toThrow("usage: expected a table")
    }
  })
})

describe("[[profiles]] config", () => {
  test("OpenCode defaults follow XDG_DATA_HOME and stay out of usage profiles", () => {
    const prior = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = "/custom/data"
    try {
      const defaults = loadConfig("/nonexistent/config.toml").profiles
      expect(defaults.find((p) => p.kind === "opencode")).toEqual({
        kind: "opencode",
        name: "default",
        home: "/custom/data/opencode",
      })
      expect(defaults.filter(hasUsage).map((p) => p.kind)).toEqual(["codex", "claude"])
      const configured = loadConfig(write('[[profiles]]\nkind = "opencode"\nname = "local"\n'))
      expect(configured.profiles[0]?.home).toBe("/custom/data/opencode")
    } finally {
      if (prior === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prior
    }
  })

  test("OpenCode custom data roots must match the CLI's /opencode directory convention", () => {
    expect(
      loadConfig(write('[[profiles]]\nkind = "opencode"\nname = "work"\nhome = "/work/opencode"'))
        .profiles[0]?.home,
    ).toBe("/work/opencode")
    expect(
      loadConfig(write('[[profiles]]\nkind = "opencode"\nname = "work"\nhome = "/work/opencode/"'))
        .profiles[0]?.home,
    ).toBe("/work/opencode")
    expect(() =>
      loadConfig(write('[[profiles]]\nkind = "opencode"\nname = "work"\nhome = "/work/other"')),
    ).toThrow("must end in /opencode")
  })

  test("CODEX_HOME moves the default codex profile, not a configured one", () => {
    const prior = process.env.CODEX_HOME
    process.env.CODEX_HOME = "/custom/codex"
    try {
      expect(loadConfig(write("")).profiles[0]?.home).toBe("/custom/codex")
      const configured = loadConfig(write('[[profiles]]\nkind = "codex"\nname = "w"'))
      expect(configured.profiles[0]?.home).toBe(join(homedir(), ".codex"))
    } finally {
      if (prior === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prior
    }
  })

  test("none falls back to the default profiles", () => {
    const defaults = loadConfig("/nonexistent/config.toml").profiles
    expect(loadConfig(write("")).profiles).toEqual(defaults)
    expect(loadConfig(write("[usage]\n")).profiles).toEqual(defaults)
  })
})

describe("[threads] config", () => {
  test("defaults", () => {
    const want: ThreadsConfig = {
      preview: true,
      livePreview: false,
      recentDays: 3,
      resume: "auto",
      raiseGhosttyTab: true,
    }
    expect(loadConfig("/nonexistent/config.toml").threads).toEqual(want)
    expect(loadConfig(write("[threads]\n")).threads).toEqual(want)
  })
  test("reads every key", () => {
    const text = `[threads]
preview = false
live_preview = true
recent_days = 7
resume = "window"
raise_ghostty_tab = false
`
    expect(loadConfig(write(text)).threads).toEqual({
      preview: false,
      livePreview: true,
      recentDays: 7,
      resume: "window",
      raiseGhosttyTab: false,
    })
  })
  test("rejects bad values", () => {
    const bad = (line: string) => () => loadConfig(write(`[threads]\n${line}\n`))
    expect(bad('live_preview = "yes"')).toThrow("threads.live_preview: expected true or false")
    expect(bad("recent_days = 0")).toThrow("threads.recent_days")
    expect(bad("recent_days = -1")).toThrow("threads.recent_days")
    expect(loadConfig(write("[threads]\nrecent_days = 0.5\n")).threads.recentDays).toBe(0.5)
    expect(bad('resume = "popup"')).toThrow('threads.resume: expected "auto" or "window"')
  })
})

describe("config errors", () => {
  const messageOf = (run: () => unknown) => {
    try {
      run()
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      return (err as Error).message
    }
    throw new Error("expected a ConfigError")
  }
  const scenes = '"night", "dawn", "day", "dusk", "auto"'

  test.each([
    ["sound = 1", "sound: expected a table ([sound])"],
    ["[sound]\nenabled = 1", "sound.enabled: expected true or false"],
    ["[sound]\nrequest = 1", "sound.request: expected a path string"],
    ["threads = 1", "threads: expected a table ([threads])"],
    ["[threads]\nraise_ghostty_tab = 1", "threads.raise_ghostty_tab: expected true or false"],
    ['[threads]\nrecent_days = "3"', "threads.recent_days: expected a number of days above 0"],
    ["usage = 5", "usage: expected a table ([usage])"],
    ['[usage]\nscene = "noon"', `usage.scene: expected one of ${scenes}, got "noon"`],
    ["profiles = 1", "profiles: expected an array of tables ([[profiles]])"],
    ["profiles = [1]", "profiles[0]: expected a table"],
    [
      '[[profiles]]\nkind = "claude"\nname = "a"\n[[profiles]]\nkind = "cursor"\nname = "b"',
      "profiles[1].kind: expected one of codex, claude, opencode",
    ],
    ['[[profiles]]\nkind = "claude"', "profiles[0].name: expected a string"],
    ['[[profiles]]\nkind = "claude"\nname = ""', "profiles[0].name: expected a string"],
    ['[[profiles]]\nkind = "claude"\nname = "a"\nhome = 1', "profiles[0].home: expected a string"],
    [
      '[[profiles]]\nkind = "opencode"\nname = "a"\nhome = "/x"',
      "profiles[0].home: OpenCode's data directory must end in /opencode",
    ],
    [
      '[[profiles]]\nkind = "claude"\nname = "w"\n[[profiles]]\nkind = "claude"\nname = "w"',
      "profiles: duplicate claude:w",
    ],
    ["privacy = true", "privacy: expected a table ([privacy])"],
    ['[privacy]\nrestricted = "work"', "privacy.restricted: expected an array of profile names"],
    ['[privacy]\nrestricted = [""]', "privacy.restricted: expected an array of profile names"],
  ])("%p", (text, message) => {
    expect(messageOf(() => loadConfig(write(text)))).toBe(message)
  })

  test("a TOML syntax error names the file", () => {
    const path = write("[threads\n")
    expect(messageOf(() => loadConfig(path))).toStartWith(`${path}: `)
  })

  test("SENU_SCENE overrides usage.scene, even an invalid one", () => {
    const prior = process.env.SENU_SCENE
    try {
      process.env.SENU_SCENE = "day"
      expect(loadConfig(write('[usage]\nscene = "noon"')).usage.scene).toBe("day")
      process.env.SENU_SCENE = "noon"
      expect(messageOf(() => loadConfig(write("")))).toBe(
        `SENU_SCENE: expected one of ${scenes}, got "noon"`,
      )
      delete process.env.SENU_SCENE
      expect(loadConfig(write("")).usage.scene).toBe("night")
      expect(loadConfig(write('[usage]\nscene = "dusk"')).usage.scene).toBe("dusk")
    } finally {
      if (prior === undefined) delete process.env.SENU_SCENE
      else process.env.SENU_SCENE = prior
    }
  })

  test("expands ~ in sound paths and profile homes", () => {
    const config = loadConfig(
      write('[sound]\ndone = "~/d.aiff"\n[[profiles]]\nkind = "claude"\nname = "w"\nhome = "~/c"'),
    )
    expect(config.sound.done).toBe(join(homedir(), "d.aiff"))
    expect(config.profiles).toEqual([{ kind: "claude", name: "w", home: join(homedir(), "c") }])
  })
})
