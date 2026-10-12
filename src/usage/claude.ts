import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { home } from "~/paths.ts"

import { errorSnapshot, nowSeconds, type Banked, type Limit, type Snapshot } from "./types.ts"

// cedar_ember=1 adds the banked-reset grants; skip_spend=1 drops the spend block senu doesn't read.
const API_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1"
const TIMEOUT_MS = 5000
const HOUR_MS = 3_600_000

type TokenResult = { token: string } | { error: string }

function tokenFromOauth(raw: string): TokenResult | null {
  const creds = JSON.parse(raw)?.claudeAiOauth
  if (!creds?.accessToken) return null
  if (creds.expiresAt && Date.now() > creds.expiresAt)
    return { error: "token expired · open Claude to refresh" }
  return { token: creds.accessToken }
}

/** Claude Code keeps a non-default config dir's credentials under a hashed keychain service. */
function keychainService(configDir: string): string {
  if (configDir === join(home, ".claude")) return "Claude Code-credentials"
  const hash = new Bun.CryptoHasher("sha256").update(configDir).digest("hex").slice(0, 8)
  return `Claude Code-credentials-${hash}`
}

function loadToken(configDir: string): TokenResult {
  try {
    const file = join(configDir, ".credentials.json")
    if (existsSync(file)) {
      const result = tokenFromOauth(readFileSync(file, "utf8"))
      if (result) return result
    }
  } catch {}

  if (process.platform === "darwin") {
    const proc = Bun.spawnSync([
      "security",
      "find-generic-password",
      "-s",
      keychainService(configDir),
      "-w",
    ])
    if (proc.exitCode === 0) {
      try {
        const result = tokenFromOauth(proc.stdout.toString())
        if (result) return result
      } catch {}
    }
  }
  return { error: "No Claude credentials" }
}

function toLimit(label: string, window: any, windowMs: number): Limit {
  const utilization = window?.utilization
  const resetsAt = window?.resets_at ? Date.parse(window.resets_at) : NaN
  return {
    label,
    left: utilization == null ? null : 100 - utilization,
    resetsAt: Number.isNaN(resetsAt) ? null : Math.floor(resetsAt / 1000),
    windowMs,
  }
}

const MODEL_WEEKS: Record<string, string> = { seven_day_opus: "Opus", seven_day_sonnet: "Sonnet" }
const MAX_MODEL_ROWS = 2

function modelWeeks(data: any): Limit[] {
  const present = Object.entries(MODEL_WEEKS)
    .filter(([key]) => typeof data?.[key]?.utilization === "number")
    .map(([key, label]) => toLimit(label, data[key], 7 * 24 * HOUR_MS))
  const kept = new Set(present.toSorted((a, b) => a.left! - b.left!).slice(0, MAX_MODEL_ROWS))
  return present.filter((l) => kept.has(l))
}

/** The server's label is a long campaign name, so name the grant by what it clears. */
function grantTitle(grant: any): string | null {
  const clears: string[] = Array.isArray(grant?.clears) ? grant.clears : []
  const parts = [
    ...(clears.includes("seven_day") ? ["Weekly"] : []),
    ...(clears.includes("five_hour") ? ["5 hr"] : []),
  ]
  if (parts.length === 2) return "Full reset (Weekly + 5 hr)"
  if (parts.length === 1) return `${parts[0]} reset`
  return grant?.label || null
}

function toBanked(status: any): Banked | null {
  if (!status?.eligible) return null
  const now = Date.now()
  const grants = (Array.isArray(status.grants) ? (status.grants as any[]) : []).filter(
    (g) => !g?.paused && !(Date.parse(g?.starts_at) > now) && !(Date.parse(g?.ends_at) <= now),
  )
  const credits = grants.flatMap((g) => {
    const expiresAt = g?.ends_at ? Date.parse(g.ends_at) : NaN
    const credit = {
      title: grantTitle(g),
      expiresAt: Number.isNaN(expiresAt) ? null : Math.floor(expiresAt / 1000),
    }
    return Array.from({ length: g?.resets_left ?? 0 }, () => credit)
  })
  return { available: credits.length, credits }
}

/** The server only reports grants to Claude Code, and checks its version. */
function userAgent(): string | null {
  try {
    const proc = Bun.spawnSync(["claude", "--version"])
    const version = proc.stdout.toString().split(" ")[0]
    return proc.exitCode === 0 && version ? `claude-cli/${version} (external, cli)` : null
  } catch {
    return null
  }
}

export async function fetchClaude(configDir: string): Promise<Snapshot> {
  const auth = loadToken(configDir)
  if ("error" in auth) return errorSnapshot(auth.error)

  const ua = userAgent()
  try {
    const res = await fetch(API_URL, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        ...(ua ? { "User-Agent": ua } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return errorSnapshot(`HTTP ${res.status}`)
    const data: any = await res.json()
    return {
      ok: true,
      error: null,
      updatedAt: nowSeconds(),
      planType: null,
      limits: [
        toLimit("Session", data.five_hour, 5 * HOUR_MS),
        toLimit("Week", data.seven_day, 7 * 24 * HOUR_MS),
        ...modelWeeks(data),
      ],
      spend: null,
      banked: toBanked(data.cedar_ember),
    }
  } catch (err) {
    return errorSnapshot(err instanceof Error ? err.message : "API request failed")
  }
}
