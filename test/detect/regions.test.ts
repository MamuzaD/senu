import { describe, expect, test } from "bun:test"
import { isHorizontalRule, isValidRegion, lines, region } from "../../src/detect/regions.ts"

const at = (screen: string, spec: string) => region({ screen, oscTitle: "title", oscProgress: "4;0" }, spec)

describe("region", () => {
  // herdr's screen_regions_extract_structure_without_classifying_agent_state, verbatim
  const cases: [string, string, string][] = [
    ["old\n\nnew\n", "bottom_lines(2)", "\nnew\n"],
    ["before\n› input\nafter\n", "after_last_prompt_marker", "after\n"],
    ["before\n› input\nafter\n", "before_current_prompt_marker", "before\n"],
    ["before\n› input\nafter\n", "whole_recent_without_current_prompt_marker", ""],
    ["no marker\n", "whole_recent_without_current_prompt_marker", "no marker\n"],
    ["• old\n■ latest\n› input\n", "current_prompt_block_marker", "■ latest"],
    ["• old\n■ latest\n› input\n", "after_current_prompt_block_marker", "■ latest\n› input\n"],
    ["› old\n• new\n", "current_prompt_block_marker", ""],
    ["above\n\n───\nbody\n───\nfooter\n", "above_prompt_box", "above\n\n"],
    ["above\n\n───\nbody\n───\nfooter\n", "last_non_empty_above_prompt_box", "above"],
    ["above\n───\nbody\n───\nfooter\n", "prompt_box_body", "body\n"],
    ["above\n───\nbody\n───\nfooter\n", "after_last_horizontal_rule", "footer\n"],
    // herdr's bottom/top occurrence tests
    ["marker\nold\n\nmiddle\nmarker\nnew\n", "bottom_non_empty_lines(2)", "marker\nnew\n"],
    ["\nmarker\nold\n\nmiddle\nmarker\nnew\n", "top_non_empty_lines(2)", "\nmarker\nold\n"],
  ]
  for (const [screen, spec, expected] of cases) {
    test(spec, () => expect(at(screen, spec)).toBe(expected))
  }

  test("osc regions read their own inputs, not the screen", () => {
    expect(at("screen", "osc_title")).toBe("title")
    expect(at("screen", "osc_progress")).toBe("4;0")
    expect(region({ screen: "x", oscTitle: "" }, "osc_progress")).toBe("")
  })

  test("a stale prompt, one with a block after it, is not the current prompt", () => {
    const screen = "› old question\n• answer\n"
    expect(at(screen, "before_current_prompt_marker")).toBe(screen)
    expect(at(screen, "whole_recent_without_current_prompt_marker")).toBe(screen)
  })

  test("with no prompt box, above_prompt_box is the whole screen and prompt_box_body is empty", () => {
    expect(at("only\n───\nfooter\n", "above_prompt_box")).toBe("only\n───\nfooter\n")
    expect(at("only\n───\nfooter\n", "prompt_box_body")).toBe("")
  })

  test("after_last_prompt_marker is the whole screen when there's no marker", () => {
    expect(at("no prompt\n", "after_last_prompt_marker")).toBe("no prompt\n")
  })

  test("lines split like Rust's str::lines(): \\r\\n is a line ending, a bare final \\r isn't", () => {
    expect(lines("a\r\nb\n")).toEqual(["a", "b"])
    expect(lines("a\nb\r")).toEqual(["a", "b\r"])
    expect(lines("a\rb\n")).toEqual(["a\rb"])
    expect(lines("\n")).toEqual([""])
    expect(lines("")).toEqual([])
  })

  test("blank means Rust's whitespace: U+0085 is blank, U+FEFF isn't", () => {
    expect(at("x\n\u0085\n", "bottom_non_empty_lines(1)")).toBe("x\n\u0085\n")
    expect(at("x\n﻿\n", "bottom_non_empty_lines(1)")).toBe("﻿\n")
  })

  test("the codex prompt marker must be at column zero", () => {
    expect(at("  › indented\nafter\n", "after_last_prompt_marker")).toBe("  › indented\nafter\n")
    expect(at("›\nafter\n", "after_last_prompt_marker")).toBe("after\n")
  })
})

describe("isHorizontalRule", () => {
  test("herdr's rule shapes", () => {
    expect(isHorizontalRule("  ─────  ")).toBe(true)
    expect(isHorizontalRule("─")).toBe(true)
    expect(isHorizontalRule("─── Title ───")).toBe(true)
    expect(isHorizontalRule("── x")).toBe(false)
    expect(isHorizontalRule("╭───╮")).toBe(false)
    expect(isHorizontalRule("-----")).toBe(false)
    expect(isHorizontalRule("   ")).toBe(false)
  })
})

describe("isValidRegion", () => {
  test("accepts herdr's names and counted regions", () => {
    for (const r of ["whole_recent", " osc_title ", "bottom_lines(3)", "bottom_non_empty_lines(0)", "top_non_empty_lines(1)", "top_non_empty_lines(65535)"]) {
      expect(isValidRegion(r)).toBe(true)
    }
  })
  test("rejects unknown names and bad top counts", () => {
    for (const r of ["nope", "bottom_lines()", "bottom_lines(-1)", "top_non_empty_lines(0)", "top_non_empty_lines(01)", "top_non_empty_lines(65536)"]) {
      expect(isValidRegion(r)).toBe(false)
    }
  })
})
