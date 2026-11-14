import { existsSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"

import { z } from "zod"

import { configPath, expandHome, home } from "./paths.ts"

export class ConfigError extends Error {}

export const opencodeHome = () =>
  join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode")

const flag = z.boolean({ error: "expected true or false" })
const soundPath = z.string({ error: "expected a path string" }).transform(expandHome)
const days = "expected a number of days above 0"
const SCENES = ["night", "dawn", "day", "dusk", "auto"] as const
const scene = z.enum(SCENES, {
  error: (issue) =>
    `expected one of ${SCENES.map((s) => `"${s}"`).join(", ")}, got ${JSON.stringify(issue.input)}`,
})

const soundSchema = z.object(
  {
    enabled: flag.default(true),
    always: flag.default(false),
    /** Optional files; an empty path uses a system sound or a generated WAV chime. */
    done: soundPath.default(""),
    request: soundPath.default(""),
  },
  { error: "expected a table ([sound])" },
)

const threadsSchema = z
  .object(
    {
      preview: flag.default(true),
      live_preview: flag.default(false),
      recent_days: z.number({ error: days }).gt(0, { error: days }).default(3),
      resume: z.enum(["auto", "window"], { error: 'expected "auto" or "window"' }).default("auto"),
      raise_ghostty_tab: flag.default(true),
    },
    { error: "expected a table ([threads])" },
  )
  .transform((t) => ({
    preview: t.preview,
    livePreview: t.live_preview,
    /** Threads untouched longer than this fold into "older". */
    recentDays: t.recent_days,
    /** "auto" resumes in this pane, or a new window from a tmux popup; "window" opens one whenever in tmux. */
    resume: t.resume,
    /** macOS: jumping to a session shown in another Ghostty tab raises that tab instead of pulling the session into this one. */
    raiseGhosttyTab: t.raise_ghostty_tab,
  }))

const KINDS = ["codex", "claude", "opencode"] as const
// Functions, not strings: opencodeHome reads XDG_DATA_HOME when called.
const kindHomes: Record<ProfileKind, () => string> = {
  codex: () => join(home, ".codex"),
  claude: () => join(home, ".claude"),
  opencode: opencodeHome,
}

const profileSchema = z
  .object(
    {
      kind: z.enum(KINDS, { error: `expected one of ${KINDS.join(", ")}` }),
      name: z.string({ error: "expected a string" }).min(1, { error: "expected a string" }),
      home: z.string({ error: "expected a string" }).optional(),
    },
    { error: "expected a table" },
  )
  .transform((p, ctx) => {
    const { kind, name } = p
    const dir = expandHome(p.home ?? kindHomes[kind]())
    if (kind !== "opencode")
      return {
        kind,
        name,
        /** CODEX_HOME, the Claude config dir, or OpenCode's data directory ending in /opencode. */
        home: dir,
      }
    if (basename(dir) !== "opencode") {
      ctx.issues.push({
        code: "custom",
        path: ["home"],
        input: p.home,
        message: "OpenCode's data directory must end in /opencode",
      })
      return z.NEVER
    }
    return { kind, name, home: resolve(dir) }
  })

function defaultProfiles(): Profile[] {
  return [
    { kind: "codex", name: "default", home: process.env.CODEX_HOME || kindHomes.codex() },
    { kind: "claude", name: "default", home: kindHomes.claude() },
    { kind: "opencode", name: "default", home: kindHomes.opencode() },
  ]
}

const configSchema = z.object({
  profiles: z
    .array(profileSchema, { error: "expected an array of tables ([[profiles]])" })
    .prefault([])
    .transform((profiles, ctx) => {
      const seen = new Set<string>()
      for (const p of profiles) {
        const key = `${p.kind}:${p.name}`
        if (seen.has(key))
          ctx.issues.push({ code: "custom", input: profiles, message: `duplicate ${key}` })
        seen.add(key)
      }
      return profiles.length ? profiles : defaultProfiles()
    }),
  privacy: z
    .object(
      {
        restricted: z
          .custom<string[]>((v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s), {
            error: "expected an array of profile names",
          })
          .default([]),
      },
      { error: "expected a table ([privacy])" },
    )
    .prefault({}),
  // SENU_SCENE overrides usage.scene, so the scene is checked after parsing, in sceneOf.
  usage: z
    .object({ scene: z.unknown().optional() }, { error: "expected a table ([usage])" })
    .prefault({}),
  threads: threadsSchema.prefault({}),
  sound: soundSchema.prefault({}),
})

export type ProfileKind = (typeof KINDS)[number]
export type Profile = z.output<typeof profileSchema>
export type UsageProfile = Profile & { kind: "codex" | "claude" }
export const hasUsage = (p: Profile): p is UsageProfile => p.kind !== "opencode"
export type UsageScene = z.output<typeof scene>
export type ThreadsConfig = z.output<typeof threadsSchema>
export type SoundConfig = z.output<typeof soundSchema>

export interface Config {
  profiles: Profile[]
  privacy?: { restricted: string[] }
  usage: { scene: UsageScene }
  threads: ThreadsConfig
  sound: SoundConfig
}

/** Parses `data`, or throws the first problem as a ConfigError like `profiles[1].kind: expected …`. */
function check<T extends z.ZodType>(schema: T, data: unknown, where: string[] = []): z.output<T> {
  const result = schema.safeParse(data)
  if (result.success) return result.data
  const { path, message } = result.error.issues[0]!
  const label = [...where, ...path]
    .map((key, i) => (typeof key === "number" ? `[${key}]` : i ? `.${String(key)}` : String(key)))
    .join("")
  throw new ConfigError(`${label}: ${message}`)
}

function sceneOf(fromConfig: unknown): UsageScene {
  const env = process.env.SENU_SCENE
  if (env) return check(scene, env, ["SENU_SCENE"])
  return check(scene.default("night"), fromConfig, ["usage", "scene"])
}

export function loadConfig(path = configPath): Config {
  let data: unknown = {}
  if (existsSync(path)) {
    try {
      data = Bun.TOML.parse(readFileSync(path, "utf8"))
    } catch (err) {
      throw new ConfigError(`${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const { usage, ...config } = check(configSchema, data)
  return { ...config, usage: { scene: sceneOf(usage.scene) } }
}
