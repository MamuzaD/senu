import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { configPath, expandHome, home } from "./paths.ts"

export type ProfileKind = "codex" | "claude"

export interface Profile {
  kind: ProfileKind
  name: string
  /** CODEX_HOME for Codex, the Claude config dir for Claude. */
  home: string
}

export type UsageScene = "night" | "dawn" | "day" | "dusk" | "auto"

export interface Config {
  profiles: Profile[]
  usage: {
    scene: UsageScene
  }
  threads: ThreadsConfig
  sound: SoundConfig
}

export interface ThreadsConfig {
  preview: boolean
  livePreview: boolean
  /** Threads untouched longer than this fold into "older". */
  recentDays: number
  /** "auto" resumes in this pane, or a new window from a tmux popup; "window" opens one whenever in tmux. */
  resume: "auto" | "window"
  /** macOS: jumping to a session shown in another Ghostty tab raises that tab instead of pulling the session into this one. */
  raiseGhosttyTab: boolean
}

export interface SoundConfig {
  enabled: boolean
  always: boolean
  /** Optional files; an empty path uses a system sound or a generated WAV chime. */
  done: string
  request: string
}

const defaultThreads = (): ThreadsConfig => ({
  preview: true,
  livePreview: false,
  recentDays: 3,
  resume: "auto",
  raiseGhosttyTab: true,
})
const defaultSound = (): SoundConfig => ({ enabled: true, always: false, done: "", request: "" })

function parseSound(raw: unknown): SoundConfig {
  const defaults = defaultSound()
  if (raw === undefined) return defaults
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError("sound: expected a table ([sound])")
  const values = raw as Record<string, unknown>
  for (const key of ["enabled", "always"] as const) {
    if (values[key] !== undefined && typeof values[key] !== "boolean")
      throw new ConfigError(`sound.${key}: expected true or false`)
  }
  for (const key of ["done", "request"] as const) {
    if (values[key] !== undefined && typeof values[key] !== "string")
      throw new ConfigError(`sound.${key}: expected a path string`)
  }
  return {
    enabled: (values.enabled as boolean | undefined) ?? defaults.enabled,
    always: (values.always as boolean | undefined) ?? defaults.always,
    done: expandHome((values.done as string | undefined) ?? defaults.done),
    request: expandHome((values.request as string | undefined) ?? defaults.request),
  }
}

function parseThreads(raw: unknown): ThreadsConfig {
  const defaults = defaultThreads()
  if (raw === undefined) return defaults
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError("threads: expected a table ([threads])")
  const values = raw as Record<string, unknown>
  for (const key of ["preview", "live_preview", "raise_ghostty_tab"] as const) {
    if (values[key] !== undefined && typeof values[key] !== "boolean")
      throw new ConfigError(`threads.${key}: expected true or false`)
  }
  const days = values.recent_days
  if (days !== undefined && !(typeof days === "number" && days > 0))
    throw new ConfigError("threads.recent_days: expected a number of days above 0")
  const resume = values.resume
  if (resume !== undefined && resume !== "auto" && resume !== "window")
    throw new ConfigError('threads.resume: expected "auto" or "window"')
  return {
    preview: (values.preview as boolean | undefined) ?? defaults.preview,
    livePreview: (values.live_preview as boolean | undefined) ?? defaults.livePreview,
    recentDays: days ?? defaults.recentDays,
    resume: resume ?? defaults.resume,
    raiseGhosttyTab: (values.raise_ghostty_tab as boolean | undefined) ?? defaults.raiseGhosttyTab,
  }
}

const KINDS: ProfileKind[] = ["codex", "claude"]
const SCENES: UsageScene[] = ["night", "dawn", "day", "dusk", "auto"]

function parseScene(raw: unknown, where: string): UsageScene {
  if (typeof raw !== "string" || !SCENES.includes(raw as UsageScene)) {
    throw new ConfigError(
      `${where}: expected one of ${SCENES.map((s) => `"${s}"`).join(", ")}, got ${JSON.stringify(raw)}`,
    )
  }
  return raw as UsageScene
}

function sceneOf(fromConfig: unknown): UsageScene {
  const env = process.env.SENU_SCENE
  if (env) return parseScene(env, "SENU_SCENE")
  return fromConfig === undefined ? "night" : parseScene(fromConfig, "usage.scene")
}

function defaultProfiles(): Profile[] {
  return [
    { kind: "codex", name: "default", home: process.env.CODEX_HOME || join(home, ".codex") },
    { kind: "claude", name: "default", home: join(home, ".claude") },
  ]
}

export class ConfigError extends Error {}

function parseProfile(raw: unknown, index: number): Profile {
  const where = `profiles[${index}]`
  if (typeof raw !== "object" || raw === null) throw new ConfigError(`${where}: expected a table`)
  const { kind, name, home: profileHome } = raw as Record<string, unknown>
  if (typeof kind !== "string" || !KINDS.includes(kind as ProfileKind)) {
    throw new ConfigError(`${where}.kind: expected one of ${KINDS.join(", ")}`)
  }
  if (typeof name !== "string" || !name) throw new ConfigError(`${where}.name: expected a string`)
  if (profileHome !== undefined && typeof profileHome !== "string") {
    throw new ConfigError(`${where}.home: expected a string`)
  }
  const fallback = kind === "codex" ? join(home, ".codex") : join(home, ".claude")
  return { kind: kind as ProfileKind, name, home: expandHome(profileHome ?? fallback) }
}

export function loadConfig(path = configPath): Config {
  if (!existsSync(path))
    return {
      profiles: defaultProfiles(),
      usage: { scene: sceneOf(undefined) },
      threads: defaultThreads(),
      sound: defaultSound(),
    }

  let data: Record<string, unknown>
  try {
    data = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch (err) {
    throw new ConfigError(`${path}: ${err instanceof Error ? err.message : String(err)}`)
  }

  const rawUsage = data.usage ?? {}
  if (typeof rawUsage !== "object" || rawUsage === null || Array.isArray(rawUsage))
    throw new ConfigError("usage: expected a table ([usage])")
  const usage = rawUsage as Record<string, unknown>
  const rawProfiles = data.profiles
  if (rawProfiles !== undefined && !Array.isArray(rawProfiles)) {
    throw new ConfigError("profiles: expected an array of tables ([[profiles]])")
  }
  const profiles = rawProfiles?.length ? rawProfiles.map(parseProfile) : defaultProfiles()

  const seen = new Set<string>()
  for (const p of profiles) {
    const key = `${p.kind}:${p.name}`
    if (seen.has(key)) throw new ConfigError(`profiles: duplicate ${key}`)
    seen.add(key)
  }

  return {
    profiles,
    usage: { scene: sceneOf(usage.scene) },
    threads: parseThreads(data.threads),
    sound: parseSound(data.sound),
  }
}
