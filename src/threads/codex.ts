import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { join } from "node:path"

import type { UsageProfile } from "~/config.ts"
import { profileKey } from "~/usage/cache.ts"

import type { Message, Thread } from "./thread.ts"
import { firstLine } from "./transcript.ts"

/**
 * Codex indexes its threads in `state_5.sqlite`, so listing them needs no
 * transcript reads. Its schema is Codex's own, not a public one: a query that
 * stops matching fails this profile only (see `listThreads`). Subagent and
 * guardian-review threads are Codex's machinery rather than conversations, and
 * a subagent can't be resumed on its own, so only user threads are kept; old
 * rows from before `thread_source` existed have none.
 */

export const CODEX_STATE_DB = "state_5.sqlite"

const QUERY = `
  SELECT id, rollout_path, cwd, coalesce(nullif(name, ''), title) AS title,
         coalesce(updated_at_ms, updated_at * 1000) AS updated_at
  FROM threads
  WHERE archived = 0 AND coalesce(thread_source, '') IN ('', 'user') AND title <> ''`

interface Row {
  id: string
  rollout_path: string
  cwd: string
  title: string
  updated_at: number
}

export function codexThreads(p: UsageProfile): Thread[] {
  const path = join(p.home, CODEX_STATE_DB)
  if (!existsSync(path)) return []
  const db = new Database(path, { readonly: true })
  try {
    return db
      .query<Row, []>(QUERY)
      .all()
      .map((r) => ({
        sessionId: r.id,
        agent: "codex" as const,
        profile: profileKey(p),
        home: p.home,
        title: firstLine(r.title),
        cwd: r.cwd,
        updatedMs: r.updated_at,
        transcript: r.rollout_path,
      }))
  } finally {
    db.close()
  }
}

export function codexMessage(r: Record<string, unknown>): Message | null {
  if (r.type !== "response_item") return null
  const p = r.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined
  if (p?.type !== "message" || (p.role !== "user" && p.role !== "assistant")) return null
  const text = (Array.isArray(p.content) ? p.content : [])
    .filter(
      (b) => (b?.type === "input_text" || b?.type === "output_text") && typeof b.text === "string",
    )
    .map((b) => b.text as string)
    .join("\n")
    .trim()
  // `<environment_context>`, `<recommended_plugins>` and the AGENTS.md dump arrive as user turns
  if (!text || text.startsWith("<") || text.startsWith("# AGENTS.md")) return null
  return { fromUser: p.role === "user", text }
}
