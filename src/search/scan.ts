import { readFileSync } from "node:fs"
import { basename } from "node:path"

import { claudeMessage } from "~/threads/claude.ts"
import { codexMessage } from "~/threads/codex.ts"

export interface Job {
  kind: "claude" | "codex"
  path: string
}
export interface Spec {
  query: string
  role: "user" | "assistant" | "tool" | "all"
  session?: string | undefined
  excluded: string[]
}
export interface Found {
  session: string
  cwd: string
  time: string
  /** Unset for a title */
  line?: number
  role: string
  excerpt: string
  /** Holds the whole phrase, not just each of its words */
  exact: boolean
  /** Equal for two copies of one message */
  key: string
}

// Characters every transcript writer stores unescaped, so a raw-line match on a run of them is exact.
const PLAIN = /[\w.,:;@#=+()[\]-]{2,}/g

export function excerpt(text: string, at: number): string {
  const start = Math.max(0, at - 100)
  const end = Math.min(text.length, at + 380)
  const cut = text.slice(start, end).trim()
  return (start ? "…" : "") + cut + (end < text.length ? "…" : "")
}

// Words this far apart are a coincidence of a long paste, not an answer to the query
const SPAN = 200

/** Where the tightest stretch holding every word starts, or -1 when the words lie further apart
 * than `SPAN` */
function near(lower: string, words: RegExp[]): number {
  const marks = words
    .flatMap((w, n) => [...lower.matchAll(w)].map((m) => ({ n, at: m.index })))
    .toSorted((a, b) => a.at - b.at)
  const last = new Map<number, number>()
  for (const m of marks) {
    last.set(m.n, m.at)
    const start = Math.min(...last.values())
    if (last.size === words.length && m.at - start <= SPAN) return start
  }
  return -1
}

/** Matches a word only at the start of one, so `is` skips `this` */
const wordStarts = (words: string[]) =>
  words.map(
    (w) =>
      new RegExp(
        (/^[a-z0-9]/.test(w) ? "(?<![a-z0-9])" : "") + w.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"),
        "g",
      ),
  )

/** Where a thread title matches, and whether it holds the whole phrase or only each of its words.
 * Most titles are short, so the words may lie anywhere in one. */
export function titleMatch(title: string, query: string): { exact: boolean; at: number } | null {
  const needle = query.toLowerCase().trim().replace(/\s+/g, " ")
  const lower = title.toLowerCase().replace(/\s+/g, " ")
  const at = lower.indexOf(needle)
  if (at >= 0) return { exact: true, at }
  const words = needle.split(" ")
  if (words.length < 2) return null
  const found = wordStarts(words).map((w) => lower.search(w))
  return found.every((i) => i >= 0) ? { exact: false, at: Math.min(...found) } : null
}

function toolText(kind: Job["kind"], r: any): string {
  if (kind === "codex")
    return r.type === "response_item" &&
      ["function_call_output", "custom_tool_call_output"].includes(r.payload?.type) &&
      typeof r.payload.output === "string"
      ? r.payload.output
      : ""
  if (r.type !== "user" || !Array.isArray(r.message?.content)) return ""
  return r.message.content
    .filter((b: { type: string }) => b.type === "tool_result")
    .map((b: { content: unknown }) =>
      typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content)
          ? b.content
              .filter((x) => x?.type === "text")
              .map((x) => x.text)
              .join("\n")
          : "",
    )
    .join("\n")
}

export function scanFile({ kind, path }: Job, spec: Spec): Found[] {
  const needle = spec.query.toLowerCase().trim().replace(/\s+/g, " ")
  const words = needle.split(" ")
  // Decoding and parsing dominate the cost, so skip files and lines that cannot hold every word.
  // Each word is checked by its longest plain run, longest word first since it is likeliest to
  // rule a line out; latin1 skips UTF-8 decoding and cannot change an ASCII match.
  const filters = words
    .flatMap((w) => (w.match(PLAIN) ?? []).toSorted((a, b) => b.length - a.length).slice(0, 1))
    .toSorted((a, b) => b.length - a.length)
    .map((run) => new RegExp(run.replace(/[.+()[\]]/g, "\\$&"), "i"))
  const starts = wordStarts(words)
  const bytes = readFileSync(path)
  const content = path.endsWith(".zst") ? Bun.zstdDecompressSync(bytes) : bytes
  if (filters.length) {
    const latin = content.toString("latin1")
    if (!filters.every((f) => f.test(latin))) return []
  }
  const found: Found[] = []
  const excluded = new Set(spec.excluded)
  let session = basename(path).replace(/\.jsonl(?:\.zst)?$/, "")
  let cwd = ""
  let skip = false
  let headed = false
  for (const [index, line] of content.toString("utf8").split("\n").entries()) {
    if (!line.includes('"session_meta"') && !filters.every((f) => f.test(line))) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (!r || typeof r !== "object") continue
    // A subagent's rollout repeats its parent's header after its own; only the first is this file's
    if (r.type === "session_meta" && !headed) {
      headed = true
      session = r.payload?.id ?? r.payload?.session_id ?? session
      cwd = r.payload?.cwd ?? cwd
      skip =
        !!r.payload?.agent_role ||
        ![undefined, "cli", "vscode", "exec", "app", "desktop"].includes(r.payload?.source)
    }
    session = r.sessionId ?? session
    cwd = typeof r.cwd === "string" ? r.cwd : cwd
    if (
      skip ||
      r.isSidechain ||
      excluded.has(session) ||
      (spec.session && spec.session !== session)
    )
      continue
    const m = kind === "claude" ? claudeMessage(r) : codexMessage(r)
    const role = m ? (m.fromUser ? "user" : "assistant") : "tool"
    if (spec.role !== "all" && spec.role !== role) continue
    const text = m?.text ?? toolText(kind, r)
    // Excerpts show one line, so a phrase may cross a line break in the source
    const flat = text.replace(/\s+/g, " ")
    const lower = flat.toLowerCase()
    let at = lower.indexOf(needle)
    const exact = at >= 0
    if (!exact) {
      if (words.length < 2) continue
      at = near(lower, starts)
      if (at < 0) continue
    }
    found.push({
      session,
      cwd,
      time: typeof r.timestamp === "string" ? r.timestamp : "",
      line: index + 1,
      role,
      excerpt: excerpt(flat, at),
      exact,
      key: `${session}\0${role}\0${Bun.hash(text)}`,
    })
  }
  return found
}
