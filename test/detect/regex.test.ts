import { describe, expect, test } from "bun:test"
import { compileRustRegex, translateRustRegex } from "../../src/detect/regex.ts"

describe("translateRustRegex", () => {
  test("\\x{HHHH} becomes a unicode escape", () => {
    expect(translateRustRegex("^[\\x{2800}-\\x{28FF}] ")).toEqual({ source: "^[\\u{2800}-\\u{28FF}] ", flags: "u" })
    expect(compileRustRegex("^[\\x{2800}-\\x{28FF}] ").test("⠂ task")).toBe(true)
  })

  test("leading flag groups become flags", () => {
    expect(translateRustRegex("(?i)esc to close").flags).toBe("iu")
    expect(translateRustRegex("(?ms)a").flags).toBe("msu")
    expect(translateRustRegex("(?m)(?s)a").flags).toBe("msu")
  })

  test("\\z is the end of the text even under (?m)", () => {
    const re = compileRustRegex("(?m)^done\\z")
    expect(re.test("x\ndone")).toBe(true)
    expect(re.test("done\nmore")).toBe(false)
    expect(compileRustRegex("continue\\s*\\z").test("Press enter to continue\n\n")).toBe(true)
  })

  test("\\A is the start of the text even under (?m)", () => {
    const re = compileRustRegex("(?m)\\A> You")
    expect(re.test("> You are in x")).toBe(true)
    expect(re.test("header\n> You are in x")).toBe(false)
  })

  test("a dot stops only at \\n, as in Rust", () => {
    expect(compileRustRegex("a.b").test("a\rb")).toBe(true)
    expect(compileRustRegex("a.b").test("a\nb")).toBe(false)
    expect(compileRustRegex("(?s)a.b").test("a\nb")).toBe(true)
  })

  test("\\d is unicode, as in Rust", () => {
    expect(compileRustRegex("^\\d$").test("٣")).toBe(true)
  })

  test("escaped punctuation JS rejects under u becomes literal", () => {
    expect(compileRustRegex("a\\#b\\-c").test("a#b-c")).toBe(true)
    expect(compileRustRegex("[a\\-z]").test("-")).toBe(true)
  })

  test("named groups use the JS spelling", () => {
    expect(compileRustRegex("(?P<n>x)").exec("x")?.groups?.n).toBe("x")
  })

  test("every pattern in the vendored manifests compiles", async () => {
    const { bundledManifest } = await import("../../src/detect/manifest.ts")
    expect(bundledManifest("claude").manifest.rules.length).toBeGreaterThan(0)
    expect(bundledManifest("codex").manifest.rules.length).toBeGreaterThan(0)
  })

  test("syntax Rust doesn't have, or JS can't mirror, is rejected", () => {
    for (const p of ["(?=x)", "(?<!x)y", "(x)\\1", "a(?i)b", "(?x)a", "[a[b]]", "[a&&b]", "\\<word"]) {
      expect(() => translateRustRegex(p)).toThrow()
    }
  })
})
