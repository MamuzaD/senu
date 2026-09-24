import { describe, expect, test } from "bun:test"
import { explainWith } from "../../src/detect/engine.ts"
import { AGENTS, bundledManifest, parseManifest, type AgentState } from "../../src/detect/manifest.ts"
import { isValidRegion } from "../../src/detect/regions.ts"

/**
 * herdr's engine-contract tests (`src/detect/manifest/tests.rs` at 9c96f7d,
 * from #4338), ported case for case where they test manifest semantics. The
 * rule-semantics and region cases live in engine.test.ts and regions.test.ts.
 * The remote-cache tests have no senu counterpart: senu has no remote cache.
 */

const codex = (rules: string) => ({ manifest: parseManifest(`id = "codex"\n${rules}`), source: "test", warning: null })

test("osc_regions_use_separate_inputs_and_share_rule_priority", () => {
  const m = codex(`
[[rules]]
id = "screen"
state = "idle"
priority = 10
region = "whole_recent"
visible_idle = true
contains = ["screen-marker"]

[[rules]]
id = "title"
state = "working"
priority = 20
region = "osc_title"
visible_working = true
regex = ['^title-marker$']

[[rules]]
id = "progress"
state = "blocked"
priority = 30
region = "osc_progress"
visible_blocker = true
regex = ['^progress-marker$']
`)
  const cases: [string, string, string, AgentState, string][] = [
    ["screen-marker", "", "", "idle", "screen"],
    ["screen-marker", "title-marker", "", "working", "title"],
    ["screen-marker", "title-marker", "progress-marker", "blocked", "progress"],
    ["screen-marker title-marker progress-marker", "", "", "idle", "screen"],
  ]
  for (const [screen, oscTitle, oscProgress, state, rule] of cases) {
    const x = explainWith(m, "codex", { screen, oscTitle, oscProgress })
    expect(x.state).toBe(state)
    expect(x.rule?.id).toBe(rule)
    expect(x.visibleIdle).toBe(state === "idle")
    expect(x.visibleWorking).toBe(state === "working")
    expect(x.visibleBlocker).toBe(state === "blocked")
  }
  const swapped = explainWith(m, "codex", { screen: "", oscTitle: "progress-marker", oscProgress: "title-marker" })
  expect(swapped.rule).toBeNull()
})

test("skip_rule_suppresses_state_update_without_visible_state_evidence", () => {
  const m = codex(`
[[rules]]
id = "activity"
state = "working"
priority = 10
visible_working = true
contains = ["activity-marker"]

[[rules]]
id = "overlay"
state = "unknown"
priority = 20
skip_state_update = true
contains = ["overlay-marker"]
`)
  const x = explainWith(m, "codex", { screen: "activity-marker overlay-marker", oscTitle: "" })
  expect(x.state).toBe("unknown")
  expect(x.skipStateUpdate).toBe(true)
  expect(x.rule?.id).toBe("overlay")
  expect(x.visibleIdle || x.visibleWorking || x.visibleBlocker).toBe(false)
})

test("codex_no_match_is_unknown_without_changing_other_agents", () => {
  const m = codex(`[[rules]]\nid = "test"\nstate = "working"\ncontains = ["active-marker"]`)
  const x = explainWith(m, "codex", { screen: "unmatched-marker", oscTitle: "" })
  expect(x.state).toBe("unknown")
  expect(x.visibleIdle).toBe(false)
  expect(x.fallback).toBe("codex_state_ambiguous")
  const other = explainWith(m, "claude", { screen: "unmatched-marker", oscTitle: "" })
  expect(other.state).toBe("idle")
  expect(other.fallback).toBe("default_known_agent_idle_fallback")
})

test("all_bundled_manifests_parse_and_validate", () => {
  for (const agent of AGENTS) expect(bundledManifest(agent).manifest.rules.length).toBeGreaterThan(0)
})

describe("manifest validation", () => {
  const rejects: Record<string, string> = {
    typo: `[[rules]]\nid = "typo"\nstate = "working"\ncontain = ["Working"]`,
    empty: `[[rules]]\nid = "empty"\nstate = "working"`,
    bad_region: `[[rules]]\nid = "bad_region"\nstate = "working"\nregion = "after_last_promt_marker"\ncontains = ["Working"]`,
    bad_regex: `[[rules]]\nid = "bad_regex"\nstate = "working"\nregex = ["["]`,
    bad_nested_regex: `[[rules]]\nid = "bad_nested_regex"\nstate = "working"\nany = [{ line_regex = ["["] }]`,
    bad_skip_state: `[[rules]]\nid = "bad_skip_state"\nstate = "idle"\nskip_state_update = true\ncontains = ["menu"]`,
    bad_skip_visible: `[[rules]]\nid = "bad_skip_visible"\nstate = "unknown"\nskip_state_update = true\nvisible_blocker = true\ncontains = ["menu"]`,
    excessive_rule_count: Array.from({ length: 129 }, (_, i) => `[[rules]]\nid = "rule_${i}"\nstate = "idle"\ncontains = ["ready"]`).join("\n"),
    excessive_gate_depth: `[[rules]]
id = "deep"
state = "idle"
contains = ["ready"]
all = [
  { contains = ["1"], all = [
    { contains = ["2"], all = [
      { contains = ["3"], all = [
        { contains = ["4"], all = [
          { contains = ["5"], all = [
            { contains = ["6"], all = [
              { contains = ["7"], all = [
                { contains = ["8"], all = [
                  { contains = ["9"] },
                ] },
              ] },
            ] },
          ] },
        ] },
      ] },
    ] },
  ] },
]`,
    excessive_matchers: `[[rules]]\nid = "many"\nstate = "idle"\ncontains = [${Array.from({ length: 33 }, (_, i) => `"m${i}"`).join(", ")}]`,
    top_non_empty_lines_below_engine_three: `version = "1"\nmin_engine_version = 2\n[[rules]]\nid = "background"\nstate = "working"\nregion = " top_non_empty_lines(1) "\ncontains = ["active"]`,
  }
  for (const [name, rules] of Object.entries(rejects)) {
    test(`rejects ${name}`, () => expect(() => parseManifest(`id = "codex"\n${rules}`)).toThrow())
  }
})

test("top_non_empty_lines_requires_a_canonical_positive_bounded_count", () => {
  expect(isValidRegion("top_non_empty_lines(1)")).toBe(true)
  expect(isValidRegion("top_non_empty_lines(65535)")).toBe(true)
  for (const n of ["0", "01", "+1", "65536", "999999999999999999999999"]) {
    expect(isValidRegion(`top_non_empty_lines(${n})`)).toBe(false)
  }
})

test("other counted regions parse like Rust's usize", () => {
  expect(isValidRegion("bottom_lines(+1)")).toBe(true)
  expect(isValidRegion("bottom_lines(18446744073709551615)")).toBe(true)
  expect(isValidRegion("bottom_lines(18446744073709551616)")).toBe(false)
})
