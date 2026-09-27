/**
 * Claude usage comes from assistant message.usage records under projects/;
 * repeated message ID and request ID pairs are counted once. Codex usage comes
 * from token_count events under sessions/, with the model from the last
 * turn_context; unchanged re-emits are skipped and copied fork history is filtered heuristically.
 * Costs use LiteLLM's public price table.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import type { UsageProfile } from "~/config.ts"
import { cacheDir, selfCommand } from "~/paths.ts"

import { claimLockFile, profileKey, releaseLockFile } from "./cache.ts"
import { nowSeconds } from "./types.ts"

export interface Today {
  /** the local day these totals are for, YYYY-MM-DD */
  day: string
  /** epoch seconds when the scan finished */
  updatedAt: number
  tokens: number
  cachedTokens: number
  /** estimated USD, or null when there's no price table at all */
  costUsd: number | null
  /** tokens from models the price table doesn't know, left out of the cost */
  unpricedTokens: number
  /** the same, per model, costliest first (missing in totals cached before it was added) */
  models?: ModelDay[]
}

export interface ModelDay {
  model: string
  tokens: number
  cachedTokens: number
  /** null when the price table doesn't know the model */
  costUsd: number | null
}

const FRESH_TTL_SECONDS = 60
const LOCK_TTL_SECONDS = 120

const RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
const RATES_TTL_SECONDS = 24 * 60 * 60
const RATES_TIMEOUT_MS = 10_000
const SCAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const SCAN_CACHE_VERSION = 2

const todayDir = join(cacheDir, "today")
const totalsPath = (p: UsageProfile) => join(todayDir, `${profileKey(p)}.json`)
const scanPath = (p: UsageProfile) => join(todayDir, `${profileKey(p)}.scan.json`)
const lockPath = (p: UsageProfile) => join(todayDir, `${profileKey(p)}.lock`)
const ratesPath = join(cacheDir, "litellm-prices.json")

function writeAtomic(path: string, data: string) {
  mkdirSync(todayDir, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

const pad = (n: number) => String(n).padStart(2, "0")

/** Returns local midnight in ms and the local date as YYYY-MM-DD. */
export function localDay(at = new Date()): { startMs: number; day: string } {
  const start = new Date(at)
  start.setHours(0, 0, 0, 0)
  return {
    startMs: start.getTime(),
    day: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
  }
}

/** USD per token, ordered as input, output, cache read, cache creation. */
type Rate = [number, number, number, number]
type Rates = Record<string, Rate>

interface RatesCache {
  fetchedAt: number
  rates: Rates
}

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null
const bareName = (key: string) => key.slice(key.lastIndexOf("/") + 1)

function parseRates(doc: unknown): Rates {
  const rates: Rates = {}
  if (typeof doc !== "object" || doc === null) return rates
  for (const [name, raw] of Object.entries(doc as Record<string, Record<string, unknown>>)) {
    if (typeof raw !== "object" || raw === null) continue
    const input = finite(raw.input_cost_per_token)
    const output = finite(raw.output_cost_per_token)
    if (input == null || output == null) continue
    const cacheRead = finite(raw.cache_read_input_token_cost) ?? input
    const cacheCreation = finite(raw.cache_creation_input_token_cost) ?? input
    rates[name.trim().toLowerCase()] = [input, output, cacheRead, cacheCreation]
  }
  const aliases = new Map<string, Rate | null>()
  for (const [key, rate] of Object.entries(rates)) {
    const alias = bareName(key)
    if (alias === key || alias in rates) continue
    const held = aliases.get(alias)
    if (held === undefined) aliases.set(alias, rate)
    else if (held && held.some((v, i) => v !== rate[i])) aliases.set(alias, null)
  }
  for (const [alias, rate] of aliases) if (rate) rates[alias] = rate
  return rates
}

async function loadRates(): Promise<Rates | null> {
  const cached = readJson(ratesPath) as RatesCache | null
  if (cached && nowSeconds() - cached.fetchedAt < RATES_TTL_SECONDS) return cached.rates
  try {
    const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(RATES_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const rates = parseRates(await res.json())
    if (Object.keys(rates).length === 0) throw new Error("empty price table")
    writeAtomic(ratesPath, JSON.stringify({ fetchedAt: nowSeconds(), rates } satisfies RatesCache))
    return rates
  } catch {
    return cached?.rates ?? null
  }
}

const UNPRICEABLE = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"])

function lookupRate(rates: Rates, model: string): Rate | null {
  let key = model.trim().toLowerCase()
  // Claude Code writes `[1m]` for the 1M-context tier; price at the base tier
  const bracket = key.indexOf("[")
  if (bracket !== -1) key = key.slice(0, bracket)
  if (!key || UNPRICEABLE.has(bareName(key))) return null
  return rates[key] ?? null
}

type UsageRecord = [
  ts: number,
  model: string,
  uncached: number,
  cached: number,
  creation: number,
  output: number,
  key: string | null,
]

interface CodexState {
  model: string
  sessionId: string
  lastSignature: string | null
  sawMeta: boolean
  forkCopy: { lastMs: number } | null
}

const initialCodexState = (): CodexState => ({
  model: "",
  sessionId: "",
  lastSignature: null,
  sawMeta: false,
  forkCopy: null,
})

const FORK_COPY_MAX_GAP_MS = 1000

const int = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0
const parseTs = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN)

function parseClaudeLine(line: string): UsageRecord | null {
  let rec: any
  try {
    rec = JSON.parse(line)
  } catch {
    return null
  }
  if (rec?.type !== "assistant") return null
  const msg = rec.message
  const usage = msg?.usage
  if (typeof usage !== "object" || usage === null) return null
  const ts = parseTs(rec.timestamp)
  const model = typeof msg.model === "string" ? msg.model : ""
  if (Number.isNaN(ts) || !model) return null
  const id = typeof msg.id === "string" ? msg.id : null
  const req = typeof rec.requestId === "string" ? rec.requestId : null
  return [
    ts,
    model,
    int(usage.input_tokens),
    int(usage.cache_read_input_tokens),
    int(usage.cache_creation_input_tokens),
    int(usage.output_tokens),
    id == null && req == null ? null : `${id ?? ""}:${req ?? ""}`,
  ]
}

function isForkMeta(payload: any): boolean {
  if (typeof payload?.forked_from_id === "string") return true
  return typeof payload?.source?.subagent?.thread_spawn?.parent_thread_id === "string"
}

function recordCodexSession(payload: any, timestamp: unknown, state: CodexState) {
  // A fork can repeat its ancestors' metadata; only the first entry identifies this session.
  if (state.sawMeta) return
  state.sawMeta = true
  const id = payload.id ?? payload.session_id
  if (typeof id === "string") state.sessionId = id
  const ts = parseTs(timestamp)
  if (!Number.isNaN(ts) && isForkMeta(payload)) state.forkCopy = { lastMs: ts }
}

function isNewCodexUsage(last: unknown, state: CodexState): boolean {
  const signature = JSON.stringify(last)
  if (signature === state.lastSignature) return false
  state.lastSignature = signature
  return true
}

function isCopiedForkUsage(ts: number, state: CodexState): boolean {
  if (!state.forkCopy) return false
  // Treat events less than one second apart after fork metadata as copied history.
  // This can skip early new usage or count copied events separated by longer gaps.
  if (ts - state.forkCopy.lastMs < FORK_COPY_MAX_GAP_MS) {
    state.forkCopy.lastMs = ts
    return true
  }
  state.forkCopy = null
  return false
}

function parseCodexLine(line: string, state: CodexState): UsageRecord | null {
  let rec: any
  try {
    rec = JSON.parse(line)
  } catch {
    return null
  }
  const payload = rec?.payload
  if (typeof payload !== "object" || payload === null) return null

  if (rec.type === "session_meta") {
    recordCodexSession(payload, rec.timestamp, state)
    return null
  }
  if (rec.type === "turn_context") {
    if (typeof payload.model === "string") state.model = payload.model
    return null
  }
  if (payload.type !== "token_count") return null
  const last = payload.info?.last_token_usage
  if (typeof last !== "object" || last === null) return null
  const ts = parseTs(rec.timestamp)
  if (Number.isNaN(ts) || !state.model) return null

  if (!isNewCodexUsage(last, state) || isCopiedForkUsage(ts, state)) return null

  const cached = int(last.cached_input_tokens)
  const creation = int(last.cache_write_input_tokens)
  const output = int(last.output_tokens)
  // Codex's input_tokens includes the cached part
  const uncached = Math.max(0, int(last.input_tokens) - cached - creation)
  if (uncached + cached + creation + output === 0) return null
  const key = `${state.sessionId}|${ts}|${state.model}|${uncached},${cached},${creation},${output}`
  return [ts, state.model, uncached, cached, creation, output, state.sessionId ? key : null]
}

interface FileEntry {
  /** File size in bytes and mtime in epoch ms at the last scan. */
  s: number
  m: number
  /** Byte offset immediately after the last complete newline-terminated record. */
  o: number
  /** Length and FNV-1a hash of the bytes just before o; detects rewrites near the resume point. */
  gl: number
  gh: number
  /** Codex parser state at o, including the model and fork-history suppression state. */
  cs: CodexState | null
  /** Retained usage records for the scanned day. */
  r: UsageRecord[]
}

interface ScanCache {
  version: number
  files: Record<string, FileEntry>
}

const GUARD_LENGTH = 64
const CHUNK = 1 << 20
const NEWLINE = 0x0a

function fnv1a(buf: Uint8Array): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < buf.length; i++) {
    hash ^= buf[i]!
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function readGuard(fd: number, offset: number, length: number): number | null {
  const buf = Buffer.alloc(length)
  return readSync(fd, buf, 0, length, offset - length) === length ? fnv1a(buf) : null
}

function listFiles(
  root: string,
  sinceMs: number,
): { path: string; size: number; mtimeMs: number }[] {
  const found: { path: string; size: number; mtimeMs: number }[] = []
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".jsonl")) {
        try {
          const st = statSync(path)
          if (st.mtimeMs >= sinceMs) found.push({ path, size: st.size, mtimeMs: st.mtimeMs })
        } catch {}
      }
    }
  }
  walk(root)
  return found
}

const CLAUDE_NEEDLE = Buffer.from('"usage"')
const CODEX_NEEDLES = ['"token_count"', '"turn_context"', '"session_meta"'].map((n) =>
  Buffer.from(n),
)

// Leave an unterminated final line for the next scan: the CLI may still be writing it.
function readFile(
  path: string,
  kind: UsageProfile["kind"],
  sinceMs: number,
  resume: FileEntry | undefined,
): { records: UsageRecord[]; entry: Omit<FileEntry, "s" | "m" | "r">; resumed: boolean } | null {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch {
    return null
  }
  try {
    let start = 0
    let state = initialCodexState()
    let resumed = false
    if (
      resume &&
      resume.o > 0 &&
      (kind !== "codex" || resume.cs) &&
      readGuard(fd, resume.o, resume.gl) === resume.gh
    ) {
      start = resume.o
      if (resume.cs)
        state = { ...resume.cs, forkCopy: resume.cs.forkCopy && { ...resume.cs.forkCopy } }
      resumed = true
    }

    const records: UsageRecord[] = []
    const onLine = (line: Buffer) => {
      if (kind === "claude") {
        if (!line.includes(CLAUDE_NEEDLE)) return
        const rec = parseClaudeLine(line.toString("utf8"))
        if (rec && rec[0] >= sinceMs) records.push(rec)
      } else {
        if (!CODEX_NEEDLES.some((n) => line.includes(n))) return
        const rec = parseCodexLine(line.toString("utf8"), state)
        if (rec && rec[0] >= sinceMs) records.push(rec)
      }
    }

    let offset = start
    let pos = start
    let pending: Buffer[] = []
    const chunk = Buffer.alloc(CHUNK)
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK, pos)
      if (n <= 0) break
      pos += n
      const read = chunk.subarray(0, n)
      if (!read.includes(NEWLINE)) {
        pending.push(Buffer.from(read))
        continue
      }
      const buf = pending.length ? Buffer.concat([...pending, read]) : read
      pending = []
      let lineStart = 0
      for (;;) {
        const nl = buf.indexOf(NEWLINE, lineStart)
        if (nl === -1) break
        onLine(buf.subarray(lineStart, nl))
        lineStart = nl + 1
      }
      offset += lineStart
      if (lineStart < buf.length) pending.push(Buffer.from(buf.subarray(lineStart)))
    }

    const gl = Math.min(GUARD_LENGTH, offset)
    const gh = gl > 0 ? (readGuard(fd, offset, gl) ?? 0) : 0
    return { records, entry: { o: offset, gl, gh, cs: kind === "codex" ? state : null }, resumed }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function dedupe(records: UsageRecord[]): UsageRecord[] {
  const seen = new Set<string>()
  return records.filter((r) => {
    const key = r[6]
    if (key == null) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function scanProfileFiles(p: UsageProfile, startMs: number): UsageRecord[][] {
  const loaded = readJson(scanPath(p)) as ScanCache | null
  const cache: ScanCache =
    loaded?.version === SCAN_CACHE_VERSION ? loaded : { version: SCAN_CACHE_VERSION, files: {} }
  const root = join(p.home, p.kind === "claude" ? "projects" : "sessions")
  const files = listFiles(root, startMs)

  const perFile: UsageRecord[][] = []
  for (const file of files) {
    const hit = cache.files[file.path]
    if (hit && hit.s === file.size && hit.m === file.mtimeMs) {
      perFile.push(hit.r.filter((r) => r[0] >= startMs))
      continue
    }
    const resume = hit && file.size > hit.s ? hit : undefined
    const parsed = readFile(file.path, p.kind, startMs, resume)
    if (!parsed) {
      if (hit) perFile.push(hit.r.filter((r) => r[0] >= startMs))
      continue
    }
    const base = parsed.resumed && hit ? hit.r.filter((r) => r[0] >= startMs) : []
    const records =
      p.kind === "claude" ? dedupe([...base, ...parsed.records]) : [...base, ...parsed.records]
    cache.files[file.path] = { s: file.size, m: file.mtimeMs, ...parsed.entry, r: records }
    perFile.push(records)
  }

  const cutoff = Date.now() - SCAN_RETENTION_MS
  for (const [path, entry] of Object.entries(cache.files)) {
    if (entry.m < cutoff) delete cache.files[path]
    else entry.r = entry.r.filter((r) => r[0] >= startMs)
  }
  writeAtomic(scanPath(p), JSON.stringify(cache))
  return perFile
}

function aggregateUsage(
  perFile: UsageRecord[][],
  kind: UsageProfile["kind"],
): Map<string, [number, number, number, number]> {
  const seen = new Set<string>()
  const byModel = new Map<string, [number, number, number, number]>()
  for (const records of perFile) {
    const occurrences = new Map<string, number>()
    for (const r of records) {
      let key = r[6]
      // Match copies across rollout files without collapsing repeated occurrences within one file.
      if (key != null && kind === "codex") {
        const n = (occurrences.get(key) ?? 0) + 1
        occurrences.set(key, n)
        key = `${key}#${n}`
      }
      if (key != null) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      const sum = byModel.get(r[1]) ?? [0, 0, 0, 0]
      for (let i = 0; i < 4; i++) sum[i]! += r[2 + i] as number
      byModel.set(r[1], sum)
    }
  }
  return byModel
}

/** Scans a profile's transcripts for the local day without updating its totals cache. */
export async function scanToday(p: UsageProfile, at = new Date()): Promise<Today> {
  const { startMs, day } = localDay(at)
  const ratesPromise = loadRates()
  const byModel = aggregateUsage(scanProfileFiles(p, startMs), p.kind)

  const rates = await ratesPromise
  let tokens = 0
  let cachedTokens = 0
  let cost = 0
  let unpricedTokens = 0
  const models: ModelDay[] = []
  for (const [model, [uncached, cached, creation, output]] of byModel) {
    const total = uncached + cached + creation + output
    if (!total) continue
    tokens += total
    cachedTokens += cached
    const rate = rates ? lookupRate(rates, model) : null
    if (!rate) {
      unpricedTokens += total
      models.push({ model, tokens: total, cachedTokens: cached, costUsd: null })
      continue
    }
    const spent = uncached * rate[0] + cached * rate[2] + creation * rate[3] + output * rate[1]
    cost += spent
    models.push({ model, tokens: total, cachedTokens: cached, costUsd: spent })
  }
  models.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.tokens - a.tokens)
  return {
    day,
    updatedAt: nowSeconds(),
    tokens,
    cachedTokens,
    costUsd: rates ? cost : null,
    unpricedTokens,
    models,
  }
}

/** Reads cached totals for the current local day; returns null without scanning when absent or stale by date. */
export function readToday(p: UsageProfile, at = new Date()): Today | null {
  const today = readJson(totalsPath(p)) as Today | null
  return today && today.day === localDay(at).day ? today : null
}

export const todayIsFresh = (t: Today | null) =>
  t?.models != null && nowSeconds() - t.updatedAt <= FRESH_TTL_SECONDS

export const claimTodayLock = (p: UsageProfile) => claimLockFile(lockPath(p), LOCK_TTL_SECONDS)

/** Scans and caches. The caller must already hold the profile's lock; it's released here. */
export async function refreshTodayLocked(p: UsageProfile): Promise<Today> {
  const release = () => releaseLockFile(lockPath(p))
  process.once("exit", release)
  try {
    const today = await scanToday(p)
    writeAtomic(totalsPath(p), JSON.stringify(today))
    return today
  } finally {
    process.off("exit", release)
    release()
  }
}

/** Starts detached refreshes for profiles with free locks; returns those now refreshing. */
export function spawnTodayRefresh(profiles: UsageProfile[]): UsageProfile[] {
  const claimed = profiles.filter(claimTodayLock)
  if (!claimed.length) return []
  try {
    // Transcript parsing is synchronous, so run it outside the animated popup.
    const child = Bun.spawn(
      [...selfCommand(), "vision", "today", ...claimed.map(profileKey), "--refresh", "--locked"],
      {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      },
    )
    child.unref()
    return claimed
  } catch {
    for (const p of claimed) releaseLockFile(lockPath(p))
    return []
  }
}
