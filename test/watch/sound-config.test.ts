import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigError, loadConfig } from "../../src/config.ts"
import { clearSoundOverride, effectiveSoundEnabled, setSoundEnabled } from "../../src/watch/sound-state.ts"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "senu-sound-")) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("sound settings default, parse and reject invalid values", () => {
  const path = join(dir, "config.toml")
  expect(loadConfig(path).sound).toEqual({ enabled: true, always: false, done: "", request: "" })
  writeFileSync(path, '[sound]\nenabled = false\nalways = true\ndone = "/tmp/done.aiff"\n')
  expect(loadConfig(path).sound).toEqual({ enabled: false, always: true, done: "/tmp/done.aiff", request: "" })
  writeFileSync(path, '[sound]\nalways = "yes"\n')
  expect(() => loadConfig(path)).toThrow(ConfigError)
})

test("runtime sound choice overrides config and reset restores it", () => {
  const path = join(dir, "nested", "sound-enabled")
  expect(effectiveSoundEnabled(true, path)).toBe(true)
  setSoundEnabled(false, path)
  expect(effectiveSoundEnabled(true, path)).toBe(false)
  setSoundEnabled(true, path)
  expect(effectiveSoundEnabled(false, path)).toBe(true)
  clearSoundOverride(path)
  expect(effectiveSoundEnabled(false, path)).toBe(false)
})
