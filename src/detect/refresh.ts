import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import type { Config } from "~/config.ts"
import { stateDir } from "~/paths.ts"

import {
  AGENTS,
  ENGINE_VERSION,
  ManifestError,
  matchesAgent,
  overrideDir,
  parseManifest,
  type Agent,
  type Manifest,
} from "./manifest.ts"
import claudeToml from "./manifests/claude.toml" with { type: "text" }
import codexToml from "./manifests/codex.toml" with { type: "text" }

/**
 * `senu scout manifest refresh`: pulls herdr's published detection manifests into
 * the override directory, so detection keeps up with Claude and Codex between
 * senu releases. A fetched file is validated with the engine's own loader
 * before it's written, and, as herdr does, a file older than the one in use, or
 * one that changed without a version bump, is refused. The watch daemon notices
 * the new file and reloads it.
 */

export const PRIMARY = "https://herdr.dev/agent-detection"
export const MIRROR =
  "https://raw.githubusercontent.com/herdrdev/herdr/HEAD/website/agent-detection"
/** herdr's MAX_FETCH_BYTES. */
const MAX_BYTES = 256 * 1024
const DAY_SECONDS = 24 * 60 * 60

const BUNDLED: Record<Agent, string> = { claude: claudeToml as string, codex: codexToml as string }

export const stampPath = join(stateDir, "last-sync")

/** Fetches a URL's text; throws on any failure. */
export type Fetcher = (url: string) => Promise<string>

export const httpFetch: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES} bytes`)
  return text
}

/** herdr's ManifestVersion order: numeric by segment, missing segments count as 0. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(BigInt)
  const y = b.split(".").map(BigInt)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0n) - (y[i] ?? 0n)
    if (d !== 0n) return d > 0n ? 1 : -1
  }
  return 0
}

/** A fetched manifest the engine would load for `agent`, with a version to compare. */
export function validateRemote(agent: Agent, text: string): Manifest & { version: string } {
  const m = parseManifest(text)
  if (!matchesAgent(m, agent))
    throw new ManifestError(`manifest id ${m.id} does not match ${agent}`)
  if (!m.version) throw new ManifestError("manifest has no version")
  if ((m.minEngineVersion ?? 0) > ENGINE_VERSION) {
    throw new ManifestError(
      `it requires engine ${m.minEngineVersion}, this is engine ${ENGINE_VERSION}`,
    )
  }
  return m as Manifest & { version: string }
}

interface Local {
  text: string
  /** null when the override doesn't parse; any valid file may replace it. */
  version: string | null
  source: "override" | "bundled"
}

/** The copy in use: the override if there is one, else the bundled manifest. */
function localCopy(agent: Agent, dir: string): Local {
  const path = join(dir, `${agent}.toml`)
  if (!existsSync(path))
    return {
      text: BUNDLED[agent],
      version: parseManifest(BUNDLED[agent]).version,
      source: "bundled",
    }
  const text = readFileSync(path, "utf8")
  let version: string | null = null
  try {
    version = parseManifest(text).version
  } catch {}
  return { text, version, source: "override" }
}

export interface Outcome {
  agent: Agent
  status: "current" | "updated" | "drift" | "failed"
  message: string
}

export interface RefreshOptions {
  fetch?: Fetcher
  /** Where overrides live; `~/.config/senu/detection` by default. */
  dir?: string
  /** Report drift without writing. */
  check?: boolean
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function fetchEither(agent: Agent, get: Fetcher): Promise<string> {
  try {
    return await get(`${PRIMARY}/${agent}.toml`)
  } catch (primary) {
    try {
      return await get(`${MIRROR}/${agent}.toml`)
    } catch (mirror) {
      throw new Error(`download failed: ${why(primary)}; mirror: ${why(mirror)}`, {
        cause: mirror,
      })
    }
  }
}

export async function refreshAgent(agent: Agent, opts: RefreshOptions = {}): Promise<Outcome> {
  const dir = opts.dir ?? overrideDir
  const fail = (message: string): Outcome => ({ agent, status: "failed", message })

  let text: string
  try {
    text = await fetchEither(agent, opts.fetch ?? httpFetch)
  } catch (err) {
    return fail(why(err))
  }
  let remote: Manifest & { version: string }
  try {
    remote = validateRemote(agent, text)
  } catch (err) {
    return fail(`fetched file is invalid, kept the current one: ${why(err)}`)
  }

  const local = localCopy(agent, dir)
  const was = `${local.source} ${local.version ?? "?"}`
  if (text === local.text)
    return { agent, status: "current", message: `up to date (${remote.version}, ${local.source})` }
  if (local.version) {
    const order = compareVersions(remote.version, local.version)
    if (order < 0) return fail(`online ${remote.version} is older than ${was}`)
    if (order === 0) return fail(`online ${remote.version} changed content without a version bump`)
  }
  if (opts.check)
    return { agent, status: "drift", message: `drift: ${was}, online ${remote.version}` }

  const dest = join(dir, `${agent}.toml`)
  try {
    mkdirSync(dir, { recursive: true })
    if (local.source === "override") copyFileSync(dest, `${dest}.bak`)
    const tmp = `${dest}.${process.pid}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, dest)
  } catch (err) {
    return fail(`could not write ${dest}: ${why(err)}`)
  }
  return { agent, status: "updated", message: `updated ${was} -> ${remote.version}` }
}

/** True if the last clean sync was under a day ago. */
export function syncedRecently(path = stampPath, now = Date.now()): boolean {
  try {
    const last = Number(readFileSync(path, "utf8").trim())
    return Number.isFinite(last) && now / 1000 - last < DAY_SECONDS
  } catch {
    return false
  }
}

export function writeStamp(path = stampPath, now = Date.now()) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${Math.floor(now / 1000)}\n`)
}

const MARK: Record<Outcome["status"], string> = {
  current: "=",
  updated: "↑",
  drift: "!",
  failed: "✗",
}

const HELP = `usage: senu scout manifest refresh [--check] [--daily]

Pulls herdr's agent-detection manifests (${PRIMARY}/<agent>.toml, with a GitHub
mirror fallback) into ${overrideDir}. A file is only written if it loads, and
only if it's newer than the one in use.

--check  report drift, write nothing (exit 1 if anything drifted)
--daily  do nothing if the last clean sync was under 24 hours ago
`

export async function manifestsCommand(
  args: string[],
  _config: Config,
  opts: RefreshOptions & { stamp?: string; now?: number } = {},
): Promise<number> {
  const [sub, ...flags] = args
  if (sub !== "refresh" || flags.some((f) => f !== "--check" && f !== "--daily")) {
    const help = !sub || sub === "-h" || sub === "--help"
    ;(help ? process.stdout : process.stderr).write(HELP)
    return help ? 0 : 2
  }
  const check = flags.includes("--check")
  const stamp = opts.stamp ?? stampPath
  if (flags.includes("--daily") && !check && syncedRecently(stamp, opts.now)) return 0

  const outcomes = await Promise.all(AGENTS.map((agent) => refreshAgent(agent, { ...opts, check })))
  for (const o of outcomes) console.log(`${MARK[o.status]} ${o.agent}: ${o.message}`)

  const failed = outcomes.some((o) => o.status === "failed")
  if (check) return failed ? 3 : outcomes.some((o) => o.status === "drift") ? 1 : 0
  // stamp only a clean run, so a failed fetch retries next time
  if (!failed) writeStamp(stamp, opts.now)
  return failed ? 3 : 0
}
