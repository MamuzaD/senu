import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ConfigError, loadConfig } from "~/config.ts"

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
  test("a missing or empty [usage] falls back to the default profiles", () => {
    const defaults = loadConfig("/nonexistent/config.toml").usage.profiles
    expect(loadConfig(write("")).usage.profiles).toEqual(defaults)
    expect(loadConfig(write("[usage]\n")).usage.profiles).toEqual(defaults)
  })
})
