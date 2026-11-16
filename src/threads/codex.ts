import { constants, Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { join } from "node:path"

import type { Profile } from "~/config.ts"
import { profileKey } from "~/usage/cache.ts"

import { threadKey, type Message, type Only, type Thread, type ToolKind } from "./thread.ts"
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

const USER_THREADS = `
  FROM threads
  WHERE archived = 0 AND coalesce(thread_source, '') IN ('', 'user') AND title <> ''`

const QUERY = `
  SELECT id, rollout_path, cwd, coalesce(nullif(name, ''), title) AS title,
         coalesce(updated_at_ms, updated_at * 1000) AS updated_at
  ${USER_THREADS}`

interface Row {
  id: string
  rollout_path: string
  cwd: string
  title: string
  updated_at: number
}

const ONLY = `
  AND (id IN (SELECT value FROM json_each(?)) OR coalesce(updated_at_ms, updated_at * 1000) >= ?)`

function openState(home: string): Database | null {
  const path = join(home, CODEX_STATE_DB)
  if (!existsSync(path)) return null
  // The db is in WAL mode, and a read-only open needs its -shm, which codex deletes when it closes
  // cleanly. With no -shm nothing is writing, so the file can be read as it is. Linux builds of
  // SQLite only read `file:` names as URIs when asked.
  const shm = existsSync(`${path}-shm`)
  return new Database(
    shm ? path : `file:${encodeURI(path)}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  )
}

export function codexThreads(p: Profile, only?: Only): Thread[] {
  const db = openState(p.home)
  if (!db) return []
  const prefix = threadKey(profileKey(p), "")
  const ids = [...(only?.ids ?? [])].flatMap((k) =>
    k.startsWith(prefix) ? [k.slice(prefix.length)] : [],
  )
  try {
    return db
      .query<Row, (string | number)[]>(only ? QUERY + ONLY : QUERY)
      .all(...(only ? [JSON.stringify(ids), only.since ?? Number.MAX_SAFE_INTEGER] : []))
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

export interface CodexThreadIdentity {
  key: string
  cwd: string
  titles: string[]
}

/** The TUI may still advertise the original title after a thread is named. */
export function codexThreadIdentities(
  p: Profile,
  open: ReadonlySet<string>,
): CodexThreadIdentity[] {
  const prefix = threadKey(profileKey(p), "")
  const ids = [...open].flatMap((key) => (key.startsWith(prefix) ? [key.slice(prefix.length)] : []))
  if (!ids.length) return []
  const db = openState(p.home)
  if (!db) return []
  try {
    return db
      .query<{ id: string; cwd: string; title: string; name: string | null }, [string]>(`
      SELECT id, cwd, title, name ${USER_THREADS}
      AND id IN (SELECT value FROM json_each(?))
    `)
      .all(JSON.stringify(ids))
      .map((r) => ({
        key: threadKey(profileKey(p), r.id),
        cwd: r.cwd,
        titles: [...new Set([r.title, r.name ?? ""].filter(Boolean))],
      }))
  } finally {
    db.close()
  }
}

const CODEX_TOOL_KINDS: Record<string, ToolKind> = {
  exec_command: "run",
  write_stdin: "run",
  shell: "run",
  apply_patch: "edit",
  view_image: "read",
  web__run: "web",
  spawn_agent: "agent",
  wait_agent: "agent",
  send_message: "agent",
  followup_task: "agent",
  list_agents: "agent",
}

export function codexTools(r: Record<string, unknown>): ToolKind[] {
  if (r.type !== "response_item") return []
  const p = r.payload as { type?: unknown; name?: unknown; input?: unknown } | undefined
  if (p?.type === "local_shell_call") return ["run"]
  if (p?.type === "web_search_call") return ["web"]
  if (p?.type !== "function_call" && p?.type !== "custom_tool_call") return []
  // Code mode sends one `exec` holding the real calls, written as `tools.<name>(…)`
  if (p.name === "exec" && typeof p.input === "string") {
    const inner = [...p.input.matchAll(/\btools\.(\w+)\(/g)].map(
      (m) => CODEX_TOOL_KINDS[m[1]!] ?? "other",
    )
    return inner.length ? inner : ["run"]
  }
  return [CODEX_TOOL_KINDS[String(p.name)] ?? "other"]
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
