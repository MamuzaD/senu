import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { home } from "../paths.ts"
import { errorSnapshot, nowSeconds, type Limit, type Snapshot } from "./types.ts"

const API_URL = "https://api.anthropic.com/api/oauth/usage"
const TIMEOUT_MS = 5000

type TokenResult = { token: string } | { error: string }

function tokenFromOauth(raw: string): TokenResult | null {
  const creds = JSON.parse(raw)?.claudeAiOauth
  if (!creds?.accessToken) return null
  if (creds.expiresAt && Date.now() > creds.expiresAt) return { error: "Claude token expired" }
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
  } catch {
    // unreadable or malformed; fall through to the keychain
  }

  if (process.platform === "darwin") {
    const proc = Bun.spawnSync(["security", "find-generic-password", "-s", keychainService(configDir), "-w"])
    if (proc.exitCode === 0) {
      try {
        const result = tokenFromOauth(proc.stdout.toString())
        if (result) return result
      } catch {}
    }
  }
  return { error: "No Claude credentials" }
}

function toLimit(label: string, window: any): Limit {
  const utilization = window?.utilization
  const resetsAt = window?.resets_at ? Date.parse(window.resets_at) : NaN
  return {
    label,
    left: utilization == null ? null : 100 - utilization,
    resetsAt: Number.isNaN(resetsAt) ? null : Math.floor(resetsAt / 1000),
  }
}

export async function fetchClaude(configDir: string): Promise<Snapshot> {
  const auth = loadToken(configDir)
  if ("error" in auth) return errorSnapshot(auth.error)

  try {
    const res = await fetch(API_URL, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
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
      limits: [toLimit("Session", data.five_hour), toLimit("Week", data.seven_day)],
      spend: null,
      banked: null,
    }
  } catch (err) {
    return errorSnapshot(err instanceof Error ? err.message : "API request failed")
  }
}
