import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { configPath, expandHome, home } from "./paths.ts"

export type UsageKind = "codex" | "claude"

export interface UsageProfile {
  kind: UsageKind
  name: string
  /** CODEX_HOME for Codex, the Claude config dir for Claude. */
  home: string
}

/** The usage popup's scene: the night desert, the day desert, or by the time of day. */
export type UsageScene = "night" | "day" | "auto"

export interface Config {
  usage: {
    profiles: UsageProfile[]
    scene: UsageScene
  }
}

const KINDS: UsageKind[] = ["codex", "claude"]
const SCENES: UsageScene[] = ["night", "day", "auto"]

function parseScene(raw: unknown, where: string): UsageScene {
  if (typeof raw !== "string" || !SCENES.includes(raw as UsageScene)) {
    throw new ConfigError(`${where}: expected one of ${SCENES.map((s) => `"${s}"`).join(", ")}, got ${JSON.stringify(raw)}`)
  }
  return raw as UsageScene
}

/** SENU_SCENE overrides the config's scene, for quick testing. */
function sceneOf(fromConfig: unknown): UsageScene {
  const env = process.env.SENU_SCENE
  if (env) return parseScene(env, "SENU_SCENE")
  return fromConfig === undefined ? "night" : parseScene(fromConfig, "usage.scene")
}

function defaultProfiles(): UsageProfile[] {
  return [
    { kind: "codex", name: "default", home: process.env.CODEX_HOME || join(home, ".codex") },
    { kind: "claude", name: "default", home: join(home, ".claude") },
  ]
}

export class ConfigError extends Error {}

function parseProfile(raw: unknown, index: number): UsageProfile {
  const where = `usage.profiles[${index}]`
  if (typeof raw !== "object" || raw === null) throw new ConfigError(`${where}: expected a table`)
  const { kind, name, home: profileHome } = raw as Record<string, unknown>
  if (typeof kind !== "string" || !KINDS.includes(kind as UsageKind)) {
    throw new ConfigError(`${where}.kind: expected one of ${KINDS.join(", ")}`)
  }
  if (typeof name !== "string" || !name) throw new ConfigError(`${where}.name: expected a string`)
  if (profileHome !== undefined && typeof profileHome !== "string") {
    throw new ConfigError(`${where}.home: expected a string`)
  }
  const fallback = kind === "codex" ? join(home, ".codex") : join(home, ".claude")
  return { kind: kind as UsageKind, name, home: expandHome(profileHome ?? fallback) }
}

export function loadConfig(path = configPath): Config {
  if (!existsSync(path)) return { usage: { profiles: defaultProfiles(), scene: sceneOf(undefined) } }

  let data: Record<string, unknown>
  try {
    data = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch (err) {
    throw new ConfigError(`${path}: ${err instanceof Error ? err.message : String(err)}`)
  }

  const usage = (data.usage ?? {}) as Record<string, unknown>
  const rawProfiles = usage.profiles
  if (rawProfiles !== undefined && !Array.isArray(rawProfiles)) {
    throw new ConfigError("usage.profiles: expected an array of tables ([[usage.profiles]])")
  }
  const profiles = rawProfiles?.length ? rawProfiles.map(parseProfile) : defaultProfiles()

  const seen = new Set<string>()
  for (const p of profiles) {
    const key = `${p.kind}:${p.name}`
    if (seen.has(key)) throw new ConfigError(`usage.profiles: duplicate ${key}`)
    seen.add(key)
  }

  return { usage: { profiles, scene: sceneOf(usage.scene) } }
}
