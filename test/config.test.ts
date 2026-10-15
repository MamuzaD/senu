import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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
    expect(() =>
      loadConfig(write('[[profiles]]\nkind = "opencode"\nname = "work"\nhome = "/work/other"')),
    ).toThrow("must end in /opencode")
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
    expect(bad('resume = "popup"')).toThrow('threads.resume: expected "auto" or "window"')
  })
})
