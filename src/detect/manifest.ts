import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { configDir } from "../paths.ts"
import claudeToml from "./manifests/claude.toml" with { type: "text" }
import codexToml from "./manifests/codex.toml" with { type: "text" }
import { compileRustRegex } from "./regex.ts"
import { isValidRegion } from "./regions.ts"

/**
 * herdr agent-detection manifests: rules that map a region of the screen to a
 * state. The vendored copies are embedded in the binary; a user override at
 * `~/.config/senu/detection/<agent>.toml` replaces one whole manifest.
 * Validation follows herdr's, so a manifest herdr would reject is rejected here.
 */

export type Agent = "claude" | "codex"
export type AgentState = "idle" | "working" | "blocked" | "unknown"

export const AGENTS: Agent[] = ["claude", "codex"]

/** The herdr engine revision this port implements (herdr's MANIFEST_ENGINE_VERSION). */
export const ENGINE_VERSION = 3

const BUNDLED: Record<Agent, string> = { claude: claudeToml as string, codex: codexToml as string }

export const overrideDir = join(configDir, "detection")
export const overridePath = (agent: Agent) => join(overrideDir, `${agent}.toml`)

/** The vendored manifest, ignoring any override. */
export const bundledManifest = (agent: Agent): LoadedManifest => ({ manifest: parseManifest(BUNDLED[agent]), source: "bundled", warning: null })

/** A matcher tree. Every matcher present must hold: all of `contains`, `regex`, `line_regex` and `all`, one of `any`, none of `not`. */
export interface Gate {
  contains: string[]
  regex: RegExp[]
  lineRegex: RegExp[]
  all: Gate[]
  any: Gate[]
  not: Gate[]
}

export interface Rule {
  id: string
  state: AgentState
  priority: number
  region: string
  visibleIdle: boolean
  visibleBlocker: boolean
  visibleWorking: boolean
  skipStateUpdate: boolean
  gate: Gate
  /** The rule as written, for `explain`. */
  raw: Record<string, unknown>
}

export interface Manifest {
  id: string
  version: string | null
  minEngineVersion: number | null
  aliases: string[]
  rules: Rule[]
}

export interface LoadedManifest {
  manifest: Manifest
  /** `bundled`, or the override's path. */
  source: string
  /** Set when an override exists but was ignored. */
  warning: string | null
}

export class ManifestError extends Error {}

// herdr's complexity caps, so an override can't make every poll slow
const MAX_RULES = 128
const MAX_GATE_DEPTH = 8
const MAX_TOTAL_GATES = 512
const MAX_MATCHERS_PER_GATE = 32
const MAX_TOTAL_MATCHERS = 1024
const MAX_MATCHER_CHARS = 512
const TOP_NON_EMPTY_LINES_ENGINE_VERSION = 3

const STATES: AgentState[] = ["idle", "working", "blocked", "unknown"]
const MANIFEST_KEYS = new Set(["id", "version", "min_engine_version", "updated_at", "aliases", "rules"])
const GATE_KEYS = ["all", "any", "not", "contains", "regex", "line_regex"]
const RULE_KEYS = new Set([
  "id",
  "state",
  "priority",
  "region",
  "visible_idle",
  "visible_blocker",
  "visible_working",
  "skip_state_update",
  ...GATE_KEYS,
])

type Table = Record<string, unknown>

const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v)

const I32_MIN = -(2 ** 31)
const I32_MAX = 2 ** 31 - 1
const U32_MAX = 2 ** 32 - 1

/**
 * An integer in range, as serde checks i32 and u32. TOML's `1.0` parses to the
 * same number as `1`, so a whole float slips through here where herdr rejects it.
 */
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max

/** herdr's ManifestVersion: a string of dot-separated digits, each segment fitting a u64. */
function parseVersion(v: unknown): string {
  if (typeof v !== "string") throw new ManifestError("manifest: version must be a string")
  const t = v.trim()
  if (!t) throw new ManifestError("manifest: version must not be empty")
  for (const seg of t.split(".")) {
    if (!/^[0-9]+$/.test(seg)) throw new ManifestError(`manifest: version ${JSON.stringify(t)} must be dotted numeric`)
    if (BigInt(seg) > 2n ** 64n - 1n) throw new ManifestError(`manifest: version ${JSON.stringify(t)} contains an oversized segment`)
  }
  return t
}

function denyUnknown(t: Table, allowed: Set<string>, where: string) {
  for (const k of Object.keys(t)) if (!allowed.has(k)) throw new ManifestError(`${where}: unknown field "${k}"`)
}

function strings(v: unknown, where: string): string[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new ManifestError(`${where}: expected an array of strings`)
  return v
}

function bool(v: unknown, where: string): boolean {
  if (v === undefined) return false
  if (typeof v !== "boolean") throw new ManifestError(`${where}: expected a boolean`)
  return v
}

interface Budget {
  gates: number
  matchers: number
}

function compileRegexes(patterns: string[], where: string): RegExp[] {
  return patterns.map((p) => {
    try {
      return compileRustRegex(p)
    } catch (err) {
      throw new ManifestError(`${where}: invalid pattern ${JSON.stringify(p)}: ${err instanceof Error ? err.message : err}`)
    }
  })
}

/**
 * Compiles and validates one gate. A gate directly inside `not` may be made of
 * nothing but a nested `not`; every other gate needs a positive matcher.
 */
function compileGate(t: Table, where: string, depth: number, budget: Budget, negated: boolean): Gate {
  if (depth > MAX_GATE_DEPTH) throw new ManifestError(`${where}: exceeds max gate depth ${MAX_GATE_DEPTH}`)
  if (++budget.gates > MAX_TOTAL_GATES) throw new ManifestError(`manifest exceeds max gate count ${MAX_TOTAL_GATES}`)

  const contains = strings(t.contains, `${where}.contains`)
  const regex = strings(t.regex, `${where}.regex`)
  const lineRegex = strings(t.line_regex, `${where}.line_regex`)
  const direct = [...contains, ...regex, ...lineRegex]
  if (direct.length > MAX_MATCHERS_PER_GATE) {
    throw new ManifestError(`${where}: has ${direct.length} direct matchers, max is ${MAX_MATCHERS_PER_GATE}`)
  }
  budget.matchers += direct.length
  if (budget.matchers > MAX_TOTAL_MATCHERS) throw new ManifestError(`manifest exceeds max matcher count ${MAX_TOTAL_MATCHERS}`)
  if (direct.some((m) => [...m].length > MAX_MATCHER_CHARS)) {
    throw new ManifestError(`${where}: matcher exceeds max length ${MAX_MATCHER_CHARS}`)
  }

  const nested = (key: "all" | "any" | "not"): Table[] => {
    const v = t[key]
    if (v === undefined) return []
    if (!Array.isArray(v) || !v.every(isTable)) throw new ManifestError(`${where}.${key}: expected an array of tables`)
    for (const g of v) denyUnknown(g, new Set(GATE_KEYS), `${where}.${key}`)
    return v
  }
  const all = nested("all")
  const any = nested("any")
  const not = nested("not")

  const positive = direct.length > 0 || all.length > 0 || any.length > 0
  if (!positive && !(negated && not.length > 0)) {
    throw new ManifestError(`${where}: must contain a ${negated ? "" : "positive "}matcher`)
  }

  return {
    // herdr lowercases needles and text: `contains` is case-insensitive
    contains: contains.map((s) => s.toLowerCase()),
    regex: compileRegexes(regex, `${where}.regex`),
    lineRegex: compileRegexes(lineRegex, `${where}.line_regex`),
    all: all.map((g) => compileGate(g, `${where} all`, depth + 1, budget, false)),
    any: any.map((g) => compileGate(g, `${where} any`, depth + 1, budget, false)),
    not: not.map((g) => compileGate(g, `${where} not`, depth + 1, budget, true)),
  }
}

export function parseManifest(text: string): Manifest {
  let data: unknown
  try {
    data = Bun.TOML.parse(text)
  } catch (err) {
    throw new ManifestError(err instanceof Error ? err.message : String(err))
  }
  if (!isTable(data)) throw new ManifestError("expected a table")
  denyUnknown(data, MANIFEST_KEYS, "manifest")

  if (typeof data.id !== "string") throw new ManifestError("manifest: id must be a string")
  const version = data.version === undefined ? null : parseVersion(data.version)
  if (data.updated_at !== undefined && typeof data.updated_at !== "string") throw new ManifestError("manifest: updated_at must be a string")
  const minEngine = data.min_engine_version
  if (minEngine !== undefined && !isInt(minEngine, 0, U32_MAX)) {
    throw new ManifestError("manifest: min_engine_version must be an integer from 0 to 2^32-1")
  }
  const rawRules = data.rules ?? []
  if (!Array.isArray(rawRules) || !rawRules.every(isTable)) throw new ManifestError("manifest: rules must be [[rules]] tables")
  if (rawRules.length === 0) throw new ManifestError("manifest must contain at least one rule")
  if (rawRules.length > MAX_RULES) throw new ManifestError(`manifest contains ${rawRules.length} rules, max is ${MAX_RULES}`)

  const budget: Budget = { gates: 0, matchers: 0 }
  const rules = rawRules.map((r): Rule => {
    const id = typeof r.id === "string" ? r.id : ""
    if (!id.trim()) throw new ManifestError("manifest rule id must not be empty")
    const where = `rule ${id}`
    denyUnknown(r, RULE_KEYS, where)

    // herdr treats a missing state as unknown
    const state = r.state === undefined ? "unknown" : r.state
    if (typeof state !== "string" || !STATES.includes(state as AgentState)) throw new ManifestError(`${where}: invalid state`)
    const priority = r.priority ?? 0
    if (!isInt(priority, I32_MIN, I32_MAX)) throw new ManifestError(`${where}: priority must be a 32-bit integer`)
    const region = r.region ?? "whole_recent"
    if (typeof region !== "string" || !isValidRegion(region)) throw new ManifestError(`${where} uses invalid region: ${region}`)
    if (region.trim().startsWith("top_non_empty_lines(") && typeof minEngine === "number" && minEngine < TOP_NON_EMPTY_LINES_ENGINE_VERSION) {
      throw new ManifestError(`${where} uses top_non_empty_lines but min_engine_version is below ${TOP_NON_EMPTY_LINES_ENGINE_VERSION}`)
    }

    const rule: Rule = {
      id,
      state: state as AgentState,
      priority,
      region,
      visibleIdle: bool(r.visible_idle, `${where}.visible_idle`),
      visibleBlocker: bool(r.visible_blocker, `${where}.visible_blocker`),
      visibleWorking: bool(r.visible_working, `${where}.visible_working`),
      skipStateUpdate: bool(r.skip_state_update, `${where}.skip_state_update`),
      gate: compileGate(r, where, 0, budget, false),
      raw: r,
    }
    if (rule.skipStateUpdate) {
      // a rule that says "leave the state alone" must say state = "unknown", and nothing visible
      if (r.state !== "unknown") throw new ManifestError(`${where} uses skip_state_update without state = "unknown"`)
      if (rule.visibleIdle || rule.visibleBlocker || rule.visibleWorking) {
        throw new ManifestError(`${where} uses skip_state_update with visible state evidence`)
      }
    }
    return rule
  })

  return {
    id: data.id,
    version,
    minEngineVersion: typeof minEngine === "number" ? minEngine : null,
    aliases: strings(data.aliases, "manifest.aliases"),
    rules,
  }
}

const matchesAgent = (m: Manifest, agent: Agent) => [m.id, ...m.aliases].some((name) => parseAgent(name) === agent)

/**
 * The override if it's usable, else the bundled manifest with a warning saying
 * why the override was ignored. Unlike herdr, an override that needs a newer
 * engine is ignored too: it would name regions this port doesn't have.
 */
export function resolveManifest(agent: Agent, path = overridePath(agent)): LoadedManifest {
  if (!existsSync(path)) return bundledManifest(agent)
  const ignored = (why: string): LoadedManifest => ({ ...bundledManifest(agent), warning: `ignored override ${path}: ${why}` })

  let manifest: Manifest
  try {
    manifest = parseManifest(readFileSync(path, "utf8"))
  } catch (err) {
    return ignored(err instanceof Error ? err.message : String(err))
  }
  if (!matchesAgent(manifest, agent)) return ignored(`manifest id ${manifest.id} does not match ${agent}`)
  if ((manifest.minEngineVersion ?? 0) > ENGINE_VERSION) {
    return ignored(`it requires engine ${manifest.minEngineVersion}, this is engine ${ENGINE_VERSION}`)
  }
  return { manifest, source: path, warning: null }
}

const cache = new Map<Agent, LoadedManifest>()

/** Loads once per process; the daemon calls `reloadManifests` to pick up edits. */
export function loadManifest(agent: Agent): LoadedManifest {
  let loaded = cache.get(agent)
  if (!loaded) {
    loaded = resolveManifest(agent)
    cache.set(agent, loaded)
  }
  return loaded
}

export function reloadManifests() {
  cache.clear()
}

/** herdr's `parse_agent_label`: a name, path or alias, any case, `.exe`/`.js`-style suffix allowed. */
export function parseAgent(name: string): Agent | null {
  const base = name.trim().split(/[/\\]/).filter(Boolean).pop() ?? ""
  const n = base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|js)$/, "")
  if (n === "claude" || n === "claude-code") return "claude"
  if (n === "codex") return "codex"
  return null
}
