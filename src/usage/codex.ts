import { errorSnapshot, nowSeconds, type Banked, type Limit, type Snapshot, type Spend } from "./types.ts"

const TIMEOUT_MS = 8000
const RATE_LIMITS_ID = 2

interface RpcBucket {
  usedPercent?: number | null
  windowDurationMins?: number | null
  resetsAt?: number | null
}

function windowLabel(mins: number | null | undefined): string {
  if (mins == null) return "Limit"
  if (mins <= 360) return "Session"
  if (mins >= 10080) return "Weekly"
  if (mins >= 1440) return `${Math.round(mins / 1440)}d`
  return `${Math.round(mins / 60)}h`
}

function toLimit(bucket: RpcBucket | null | undefined): Limit | null {
  if (!bucket) return null
  return {
    label: windowLabel(bucket.windowDurationMins),
    left: bucket.usedPercent == null ? null : 100 - bucket.usedPercent,
    resetsAt: bucket.resetsAt ?? null,
  }
}

function toSpend(limit: any, reached: unknown): Spend | null {
  if (!limit) return null
  const used = Number(limit.used)
  const cap = Number(limit.limit)
  if (!Number.isFinite(used) || !Number.isFinite(cap)) return null
  return {
    used,
    limit: cap,
    left: limit.remainingPercent ?? null,
    resetsAt: limit.resetsAt ?? null,
    reached: Boolean(reached),
  }
}

function toBanked(summary: any): Banked | null {
  if (!summary) return null
  const credits = ((summary.credits ?? []) as any[])
    .filter((c) => c.status === "available")
    .map((c) => ({ title: c.title ?? null, expiresAt: c.expiresAt ?? null }))
  return { available: summary.availableCount ?? 0, credits }
}

export function parseRateLimits(result: any): Snapshot {
  const rateLimits = result?.rateLimits ?? {}
  return {
    ok: true,
    error: null,
    updatedAt: nowSeconds(),
    planType: rateLimits.planType ?? null,
    limits: [toLimit(rateLimits.primary), toLimit(rateLimits.secondary)].filter((l): l is Limit => l !== null),
    spend: toSpend(rateLimits.individualLimit, rateLimits.spendControlReached),
    banked: toBanked(result?.rateLimitResetCredits),
  }
}

/** Reads newline-delimited JSON until the response with `id` arrives; null if stdout closes first. */
async function readResponse(stdout: ReadableStream<Uint8Array>, id: number): Promise<any | null> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        const message = JSON.parse(line)
        if (message.id === id) return message
      } catch {
        // not JSON; codex can log to stdout during startup
      }
    }
  }
  return null
}

/** Asks `codex app-server` for the account's rate limits over JSON-RPC on stdio. */
export async function fetchCodex(codexHome: string): Promise<Snapshot> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">
  try {
    proc = Bun.spawn(["codex", "-s", "read-only", "-a", "never", "app-server"], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch {
    return errorSnapshot("Codex CLI not found")
  }

  let timer: Timer | undefined
  try {
    const requests = [
      { id: 1, method: "initialize", params: { clientInfo: { name: "senu", version: "0.1.0" } } },
      { method: "initialized", params: {} },
      { id: RATE_LIMITS_ID, method: "account/rateLimits/read", params: {} },
    ]
    proc.stdin.write(requests.map((r) => JSON.stringify(r) + "\n").join(""))
    proc.stdin.flush()

    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), TIMEOUT_MS)
    })
    const response = await Promise.race([readResponse(proc.stdout, RATE_LIMITS_ID), timeout])

    if (response === "timeout") return errorSnapshot("Timed out waiting for rate limits")
    if (response === null) {
      // stdout closed: the process exited, usually on a bad flag or missing auth
      const code = await proc.exited
      const stderr = (await new Response(proc.stderr).text()).trim()
      return errorSnapshot(stderr.split("\n").at(-1) || `codex app-server exited (${code})`)
    }
    if (response.error) return errorSnapshot(response.error.message || "RPC request failed")
    return parseRateLimits(response.result)
  } catch (err) {
    return errorSnapshot(err instanceof Error ? err.message : "RPC probe failed")
  } finally {
    clearTimeout(timer)
    proc.kill()
  }
}
