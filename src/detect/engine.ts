import { loadManifest, type Agent, type AgentState, type Gate, type LoadedManifest, type Rule } from "./manifest.ts"
import { lines, region, type DetectionInput } from "./regions.ts"

/**
 * herdr's rule evaluation. Every rule is evaluated; the highest priority match
 * wins and a tie goes to the rule earlier in the file. With no match a known
 * agent is idle, except Codex, whose screen herdr calls ambiguous: unknown.
 */

export interface Detection {
  agent: Agent
  /** The state to show. For a `skip_state_update` match, the previous state. */
  state: AgentState
  /** The winning rule, or null when the fallback decided. */
  rule: Rule | null
  /** The winning rule said to leave the state alone (a transcript viewer, a menu). */
  skipStateUpdate: boolean
  /**
   * The winning rule saw direct on-screen evidence of its state. herdr uses these
   * to publish at once instead of debouncing a working → idle flip.
   */
  visibleIdle: boolean
  visibleBlocker: boolean
  visibleWorking: boolean
  /** Why no rule decided: herdr's `fallback_reason`. */
  fallback: "default_known_agent_idle_fallback" | "codex_state_ambiguous" | null
}

export interface EvaluatedRule {
  rule: Rule
  text: string
  matched: boolean
}

export interface Explanation extends Detection {
  loaded: LoadedManifest
  /** Every rule in file order, with the region text it saw. */
  evaluated: EvaluatedRule[]
}

function gateMatches(g: Gate, text: string, lower: string): boolean {
  if (!g.contains.every((needle) => lower.includes(needle))) return false
  if (!g.regex.every((re) => re.test(text))) return false
  if (g.lineRegex.length) {
    const ls = lines(text)
    if (!g.lineRegex.every((re) => ls.some((l) => re.test(l)))) return false
  }
  if (!g.all.every((n) => gateMatches(n, text, lower))) return false
  if (g.any.length && !g.any.some((n) => gateMatches(n, text, lower))) return false
  if (g.not.some((n) => gateMatches(n, text, lower))) return false
  return true
}

export const ruleMatches = (rule: Rule, text: string) => gateMatches(rule.gate, text, text.toLowerCase())

export function explainWith(loaded: LoadedManifest, agent: Agent, input: DetectionInput, previous: AgentState | null = null): Explanation {
  const regions = new Map<string, string>()
  const evaluated: EvaluatedRule[] = []
  let winner: Rule | null = null

  for (const rule of loaded.manifest.rules) {
    let text = regions.get(rule.region)
    if (text === undefined) {
      text = region(input, rule.region)
      regions.set(rule.region, text)
    }
    const matched = ruleMatches(rule, text)
    evaluated.push({ rule, text, matched })
    if (matched && (!winner || rule.priority > winner.priority)) winner = rule
  }

  if (!winner) {
    const codex = agent === "codex"
    return {
      agent,
      state: codex ? "unknown" : "idle",
      rule: null,
      skipStateUpdate: false,
      visibleIdle: false,
      visibleBlocker: false,
      visibleWorking: false,
      fallback: codex ? "codex_state_ambiguous" : "default_known_agent_idle_fallback",
      loaded,
      evaluated,
    }
  }

  const s = winner.state
  return {
    agent,
    state: winner.skipStateUpdate ? (previous ?? "unknown") : s,
    rule: winner,
    skipStateUpdate: winner.skipStateUpdate,
    visibleIdle: winner.visibleIdle && s === "idle",
    visibleBlocker: winner.visibleBlocker && s === "blocked",
    visibleWorking: winner.visibleWorking && s === "working",
    fallback: null,
    loaded,
    evaluated,
  }
}

/**
 * Classifies one screen. `previous` is what the caller last showed for this
 * pane; it's kept when the winning rule says `skip_state_update`.
 */
export function classify(agent: Agent, input: DetectionInput, previous: AgentState | null = null): Detection {
  const { loaded: _loaded, evaluated: _evaluated, ...detection } = explainWith(loadManifest(agent), agent, input, previous)
  return detection
}

export function explain(agent: Agent, input: DetectionInput, previous: AgentState | null = null): Explanation {
  return explainWith(loadManifest(agent), agent, input, previous)
}
