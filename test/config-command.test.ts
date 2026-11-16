import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { configToml } from "~/config-command.ts"
import { defaultConfig, loadConfig } from "~/config.ts"

const cli = join(import.meta.dir, "../src/cli.ts")
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "senu-config-cli-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, cli, "config", ...args], {
    cwd: tmpdir(),
    env: { ...process.env, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, SENU_SCENE: "", ...env },
  })
}

function file(text: string) {
  const path = join(dir, "senu/config.toml")
  mkdirSync(join(dir, "senu"), { recursive: true })
  writeFileSync(path, text)
  return path
}

test("default TOML round-trips every schema option without changing the config file", () => {
  const defaults = defaultConfig()
  const text = configToml(defaults)
  const path = join(dir, "defaults.toml")
  writeFileSync(path, text)
  // loadConfig applies SENU_SCENE, so compare its other fields independently.
  const loaded = loadConfig(path)
  expect(loaded.profiles).toEqual(defaults.profiles)
  expect(loaded.threads).toEqual(defaults.threads)
  expect(loaded.sound).toEqual(defaults.sound)
  expect(loaded.privacy).toEqual(defaults.privacy)
  expect((Bun.TOML.parse(text) as { usage: { scene: string } }).usage.scene).toBe("night")
})

test("effective settings use TOML keys, defaults, file values and environment overrides", () => {
  const path = file(
    '[usage]\nscene = "dusk"\n[threads]\nlive_preview = true\nrecent_days = 1.5\n[sound]\nalways = true\n[privacy]\nrestricted = ["work"]\n',
  )
  const before = readFileSync(path, "utf8")
  const result = run([], { SENU_SCENE: "day" })
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe("")
  expect(result.stdout.toString()).toContain(path)
  const toml = Bun.TOML.parse(result.stdout.toString())
  expect(toml).toMatchObject({
    usage: { scene: "day" },
    threads: {
      preview: true,
      live_preview: true,
      recent_days: 1.5,
      resume: "auto",
      raise_ghostty_tab: true,
    },
    sound: { enabled: true, always: true, done: "", request: "" },
    privacy: { restricted: ["work"] },
  })
  expect(readFileSync(path, "utf8")).toBe(before)
})

test("defaults and help work even when the user's config and SENU_SCENE are invalid", () => {
  const path = file("this is not = [toml")
  for (const args of [["--defaults"], ["--help"]]) {
    const result = run(args, { SENU_SCENE: "invalid" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe("")
    if (args[0] === "--defaults") {
      expect(Bun.TOML.parse(result.stdout.toString())).toMatchObject({ usage: { scene: "night" } })
      expect(result.stdout.toString()).not.toContain(path)
    }
  }
  expect(readFileSync(path, "utf8")).toBe("this is not = [toml")
  const effective = run([])
  expect(effective.exitCode).toBe(2)
  expect(effective.stderr.toString()).toContain("senu: config:")
})

test("missing config is reported without creating a file; unknown options fail", () => {
  const result = run([])
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("not found; using defaults")
  expect(existsSync(join(dir, "senu/config.toml"))).toBe(false)
  expect(run(["--unknown"]).exitCode).toBe(2)
})

test("quoted strings round-trip through the printed TOML", () => {
  const config = defaultConfig()
  config.sound.done = '/tmp/chime "one"\\two\nthree.wav'
  config.profiles[0]!.name = 'my "profile"'
  config.privacy = { restricted: ['my "profile"'] }
  const parsed = Bun.TOML.parse(configToml(config))
  expect(parsed).toMatchObject({
    sound: { done: config.sound.done },
    profiles: config.profiles,
    privacy: config.privacy,
  })
})
