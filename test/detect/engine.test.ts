import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { explainWith } from "~/detect/engine.ts"
import { bundledManifest, parseManifest, type Agent, type AgentState } from "~/detect/manifest.ts"

const loaded = (rules: string) => ({
  manifest: parseManifest(`id = "codex"\n${rules}`),
  source: "test",
  warning: null,
})
const run = (
  rules: string,
  screen: string,
  agent: Agent = "codex",
  previous: AgentState | null = null,
) => explainWith(loaded(rules), agent, { screen, oscTitle: "" }, previous)

describe("herdr rule semantics", () => {
  const rules = `
[[rules]]
id = "low_contains"
state = "idle"
priority = 1
contains = ["match"]

[[rules]]
id = "high_nested_gates"
state = "working"
priority = 10
contains = ["match"]
all = [
  { any = [{ regex = ["w[io]n"] }, { contains = ["fallback"] }] },
]
not = [
  { contains = ["blocked"] },
]

[[rules]]
id = "line_regex"
state = "blocked"
priority = 20
line_regex = ["^exact line$"]
`
  test("nested gates and priority", () =>
    expect(run(rules, "match win").rule?.id).toBe("high_nested_gates"))
  test("a not gate knocks out a higher rule", () =>
    expect(run(rules, "match win blocked").rule?.id).toBe("low_contains"))
  test("line_regex matches a whole line", () =>
    expect(run(rules, "before\nexact line\nafter").rule?.id).toBe("line_regex"))

  test("contains is case-insensitive", () => {
    const r = `[[rules]]\nid = "r"\nstate = "blocked"\ncontains = ["do you want to proceed?"]`
    expect(run(r, "Do You Want To Proceed?").state).toBe("blocked")
  })

  test("regex needs every pattern to match (the python accepted any one)", () => {
    const r = `[[rules]]\nid = "r"\nstate = "blocked"\nregex = ["foo", "bar"]`
    expect(run(r, "foo").rule).toBeNull()
    expect(run(r, "bar foo").rule?.id).toBe("r")
  })

  test("line_regex needs every pattern to match some line (the python accepted any one)", () => {
    const r = `[[rules]]\nid = "r"\nstate = "working"\nline_regex = ['^/btw', 'esc to close$']`
    expect(run(r, "/btw what now").rule).toBeNull()
    expect(run(r, "/btw what now\n  esc to close").rule?.id).toBe("r")
    expect(run(r, "/btw esc to close").rule?.id).toBe("r")
  })

  test("the highest priority wins wherever it is in the file", () => {
    const r = `
[[rules]]
id = "first"
state = "idle"
priority = 1
contains = ["x"]

[[rules]]
id = "second"
state = "working"
priority = 5
contains = ["x"]
`
    expect(run(r, "x").rule?.id).toBe("second")
  })

  test("a priority tie goes to the rule earlier in the file", () => {
    const r = `
[[rules]]
id = "first"
state = "idle"
priority = 5
contains = ["x"]

[[rules]]
id = "second"
state = "working"
priority = 5
contains = ["x"]
`
    expect(run(r, "x").rule?.id).toBe("first")
  })

  test("with no match, codex is unknown and every other agent idle", () => {
    const r = `[[rules]]\nid = "r"\nstate = "working"\ncontains = ["never"]`
    const codex = run(r, "nothing", "codex")
    expect(codex.state).toBe("unknown")
    expect(codex.fallback).toBe("codex_state_ambiguous")
    const claude = run(r, "nothing", "claude")
    expect(claude.state).toBe("idle")
    expect(claude.fallback).toBe("default_known_agent_idle_fallback")
  })

  test("skip_state_update keeps the previous state", () => {
    const r = `[[rules]]\nid = "viewer"\nstate = "unknown"\nskip_state_update = true\ncontains = ["transcript"]`
    const x = run(r, "transcript", "codex", "working")
    expect(x.state).toBe("working")
    expect(x.skipStateUpdate).toBe(true)
    expect(run(r, "transcript").state).toBe("unknown")
  })

  test("visible_* only holds when the rule's state is the one claimed", () => {
    const r = `[[rules]]\nid = "r"\nstate = "idle"\nvisible_idle = true\nvisible_working = true\ncontains = ["x"]`
    const x = run(r, "x")
    expect(x.visibleIdle).toBe(true)
    expect(x.visibleWorking).toBe(false)
  })
})

const FIXTURES = join(import.meta.dir, "../fixtures/detect")
const cases: {
  name: string
  agent: Agent
  state: AgentState
  rule: string
  python?: AgentState
  previous?: AgentState
}[] = [
  { name: "live-claude-idle", agent: "claude", state: "idle", rule: "live_prompt_box" },
  { name: "live-claude-idle-draft", agent: "claude", state: "idle", rule: "live_prompt_box" },
  { name: "live-codex-idle", agent: "codex", state: "idle", rule: "osc_title_idle" },
  { name: "live-codex-idle-draft", agent: "codex", state: "idle", rule: "osc_title_idle" },

  { name: "claude-working-title", agent: "claude", state: "working", rule: "osc_title_working" },
  { name: "claude-working-screen", agent: "claude", state: "working", rule: "live_turn_working" },
  {
    name: "claude-blocked-bash",
    agent: "claude",
    state: "blocked",
    rule: "bash_permission_prompt",
  },
  {
    name: "claude-blocked-edit",
    agent: "claude",
    state: "blocked",
    rule: "legacy_no_prompt_blocker",
    python: "idle",
  },
  {
    name: "claude-blocked-question",
    agent: "claude",
    state: "blocked",
    rule: "live_blocked_form",
    python: "idle",
  },
  {
    name: "claude-transcript-viewer",
    agent: "claude",
    state: "working",
    rule: "transcript_viewer",
    previous: "working",
    python: "idle",
  },
  {
    name: "claude-overlay-esc-to-close",
    agent: "claude",
    state: "idle",
    rule: "osc_title_idle",
    python: "working",
  },
  {
    name: "claude-no-signal",
    agent: "claude",
    state: "idle",
    rule: "default_known_agent_idle_fallback",
  },

  { name: "codex-working-title", agent: "codex", state: "working", rule: "osc_title_working" },
  {
    name: "codex-working-screen",
    agent: "codex",
    state: "working",
    rule: "screen_working_fallback",
    python: "idle",
  },
  {
    name: "codex-blocked-approval",
    agent: "codex",
    state: "blocked",
    rule: "live_strong_blocker",
    python: "idle",
  },
  { name: "codex-blocked-title", agent: "codex", state: "blocked", rule: "osc_title_blocked" },
  {
    name: "codex-weak-blocker",
    agent: "codex",
    state: "blocked",
    rule: "weak_blocker",
    python: "idle",
  },
  { name: "codex-no-title", agent: "codex", state: "unknown", rule: "codex_state_ambiguous" },
]

describe("pane fixtures", () => {
  const manifests = { claude: bundledManifest("claude"), codex: bundledManifest("codex") }
  for (const c of cases) {
    test(`${c.name}: ${c.state}${c.python ? ` (python said ${c.python})` : ""}`, () => {
      const screen = readFileSync(join(FIXTURES, `${c.name}.screen`), "utf8")
      const oscTitle = readFileSync(join(FIXTURES, `${c.name}.title`), "utf8")
      const x = explainWith(manifests[c.agent], c.agent, { screen, oscTitle }, c.previous ?? null)
      expect(x.state).toBe(c.state)
      expect(x.rule?.id ?? x.fallback).toBe(c.rule)
    })
  }
})
