import { describe, expect, test } from "bun:test"

import { compileRustRegex, translateRustRegex } from "~/detect/regex.ts"

describe("translateRustRegex", () => {
  test("\\x{HHHH} becomes a unicode escape", () => {
    expect(translateRustRegex("^[\\x{2800}-\\x{28FF}] ")).toEqual({
      source: "^[\\u{2800}-\\u{28FF}] ",
      flags: "u",
    })
    expect(compileRustRegex("^[\\x{2800}-\\x{28FF}] ").test("⠂ task")).toBe(true)
  })

  test("leading flag groups become flags", () => {
    expect(translateRustRegex("(?i)esc to close").flags).toBe("iu")
    expect(translateRustRegex("(?is)a").flags).toBe("isu")
    expect(translateRustRegex("(?m)(?s)a").flags).toBe("su")
  })

  test("(?m) ^ and $ break lines only at \\n, as in Rust", () => {
    const re = compileRustRegex("(?m)^\\s*❯\\s*$")
    expect(re.test("foo\n❯\nbar")).toBe(true)
    expect(re.test("❯")).toBe(true)
    expect(re.test("foo\r❯x")).toBe(false)
    expect(compileRustRegex("(?m)running[ \\t]*$").test("still running\r\n")).toBe(false)
    expect(compileRustRegex("(?m)running[ \\t]*$").test("still running\nnext")).toBe(true)
    expect(compileRustRegex("(?m)[$^]").test("^")).toBe(true)
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

  test("\\s is Unicode White_Space, which leaves out U+FEFF", () => {
    expect(compileRustRegex("^\\s$").test("　")).toBe(true)
    expect(compileRustRegex("^\\s$").test("﻿")).toBe(false)
    expect(compileRustRegex("^[^\\s›]+$").test("ab")).toBe(true)
  })

  test("\\w and \\b are Unicode, as in Rust", () => {
    expect(compileRustRegex("^\\w+$").test("café")).toBe(true)
    expect(compileRustRegex("(?i)^\\s*❯?\\s*yes\\b").test("❯ Yes, and")).toBe(true)
    expect(compileRustRegex("(?i)yes\\b").test("yesé")).toBe(false)
    expect(compileRustRegex("a\\Bb").test("ab")).toBe(true)
  })

  test("escaped punctuation JS rejects under u becomes literal", () => {
    expect(compileRustRegex("a\\#b\\-c").test("a#b-c")).toBe(true)
    expect(compileRustRegex("[a\\-z]").test("-")).toBe(true)
  })

  test("named groups use the JS spelling", () => {
    expect(compileRustRegex("(?P<n>x)").exec("x")?.groups?.n).toBe("x")
  })

  test("every pattern in the vendored manifests compiles", async () => {
    const { bundledManifest } = await import("~/detect/manifest.ts")
    expect(bundledManifest("claude").manifest.rules.length).toBeGreaterThan(0)
    expect(bundledManifest("codex").manifest.rules.length).toBeGreaterThan(0)
  })

  test("syntax Rust doesn't have, or JS can't mirror, is rejected", () => {
    for (const p of [
      "(?=x)",
      "(?<!x)y",
      "(x)\\1",
      "a(?i)b",
      "(?x)a",
      "[a[b]]",
      "[a&&b]",
      "\\<word",
      "[\\b]",
      "[\\W]",
    ]) {
      expect(() => translateRustRegex(p)).toThrow()
    }
  })
})
