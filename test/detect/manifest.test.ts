import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManifestError, parseManifest, resolveManifest } from "../../src/detect/manifest.ts"

const rule = (body: string) => `id = "codex"\n[[rules]]\nid = "r"\n${body}`

describe("parseManifest", () => {
  test("defaults: region whole_recent, priority 0, state unknown", () => {
    const [r] = parseManifest(rule(`contains = ["x"]`)).rules
    expect(r).toMatchObject({ region: "whole_recent", priority: 0, state: "unknown" })
  })

  test("contains needles are lowercased once, at load", () => {
    expect(parseManifest(rule(`contains = ["Do You"]`)).rules[0]!.gate.contains).toEqual(["do you"])
  })

  // herdr's manifest_validation_* tests
  const invalid: [string, string][] = [
    ["no rules", `id = "codex"`],
    ["unknown manifest field", `id = "codex"\nextra = 1\n[[rules]]\nid = "r"\ncontains = ["x"]`],
    ["unknown rule field", rule(`contains = ["x"]\nbogus = true`)],
    ["unknown gate field", rule(`any = [{ contain = ["x"] }]`)],
    ["invalid region", rule(`region = "nowhere"\ncontains = ["x"]`)],
    ["invalid regex", rule(`regex = ["("]`)],
    ["no positive matcher", rule(`not = [{ contains = ["x"] }]`)],
    ["empty rule id", `id = "codex"\n[[rules]]\nid = " "\ncontains = ["x"]`],
    ["skip rule with no state", rule(`skip_state_update = true\ncontains = ["x"]`)],
    ["skip rule with a state", rule(`state = "idle"\nskip_state_update = true\ncontains = ["x"]`)],
    ["skip rule with visible evidence", rule(`state = "unknown"\nskip_state_update = true\nvisible_idle = true\ncontains = ["x"]`)],
    ["top_non_empty_lines below engine 3", `id = "codex"\nmin_engine_version = 2\n[[rules]]\nid = "r"\nregion = "top_non_empty_lines(3)"\ncontains = ["x"]`],
    ["too many rules", `id = "codex"\n${Array.from({ length: 129 }, (_, i) => `[[rules]]\nid = "r${i}"\ncontains = ["x"]`).join("\n")}`],
    ["gates too deep", rule(`contains = ["x"]\nall = [{ all = [{ all = [{ all = [{ all = [{ all = [{ all = [{ all = [{ all = [{ contains = ["x"] }] }] }] }] }] }] }] }] }]`)],
    ["a non-numeric version", `id = "codex"\nversion = "2026.09.x"\n[[rules]]\nid = "r"\ncontains = ["x"]`],
    ["a numeric (not string) version", `id = "codex"\nversion = 3\n[[rules]]\nid = "r"\ncontains = ["x"]`],
    ["an empty version segment", `id = "codex"\nversion = "2026..1"\n[[rules]]\nid = "r"\ncontains = ["x"]`],
    ["a non-string updated_at", `id = "codex"\nupdated_at = 5\n[[rules]]\nid = "r"\ncontains = ["x"]`],
    ["a priority outside i32", rule(`priority = 2147483648\ncontains = ["x"]`)],
    ["a negative min_engine_version", `id = "codex"\nmin_engine_version = -1\n[[rules]]\nid = "r"\ncontains = ["x"]`],
    ["too many matchers in a gate", rule(`contains = [${Array.from({ length: 33 }, () => `"x"`).join(", ")}]`)],
  ]
  for (const [name, text] of invalid) {
    test(`rejects ${name}`, () => expect(() => parseManifest(text)).toThrow(ManifestError))
  }

  test("a not gate may hold nothing but another not", () => {
    expect(() => parseManifest(rule(`contains = ["x"]\nnot = [{ not = [{ contains = ["y"] }] }]`))).not.toThrow()
  })
})

describe("resolveManifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "senu-detect-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const write = (name: string, text: string) => {
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }

  test("no override: the bundled manifest", () => {
    const m = resolveManifest("codex", join(dir, "missing.toml"))
    expect(m.source).toBe("bundled")
    expect(m.warning).toBeNull()
  })

  test("a valid override replaces the whole manifest", () => {
    const path = write("codex.toml", rule(`state = "blocked"\ncontains = ["x"]`))
    const m = resolveManifest("codex", path)
    expect(m.source).toBe(path)
    expect(m.manifest.rules.map((r) => r.id)).toEqual(["r"])
  })

  test("the id matches the way herdr parses agent labels", () => {
    const path = write("claude-label.toml", `id = "Claude"\n[[rules]]\nid = "r"\ncontains = ["x"]`)
    expect(resolveManifest("claude", path).source).toBe(path)
  })

  test("an alias counts as the agent's id", () => {
    const path = write("claude.toml", `id = "claude-code"\n[[rules]]\nid = "r"\ncontains = ["x"]`)
    expect(resolveManifest("claude", path).source).toBe(path)
  })

  const ignored: [string, string][] = [
    ["broken TOML", "id = "],
    ["an invalid rule", rule(`region = "nowhere"\ncontains = ["x"]`)],
    ["another agent's id", `id = "gemini"\n[[rules]]\nid = "r"\ncontains = ["x"]`],
    ["a newer engine", `id = "codex"\nmin_engine_version = 4\n[[rules]]\nid = "r"\ncontains = ["x"]`],
  ]
  for (const [name, text] of ignored) {
    test(`an override with ${name} is ignored, with a warning`, () => {
      const m = resolveManifest("codex", write(`bad-${name.replace(/\W/g, "")}.toml`, text))
      expect(m.source).toBe("bundled")
      expect(m.warning).toContain("ignored override")
    })
  }
})
