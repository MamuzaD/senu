import { constants, Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import type { Profile } from "~/config.ts"
import { profileKey } from "~/usage/cache.ts"

import { threadKey, type Message, type Only, type Thread, type ToolKind } from "./thread.ts"
import { firstLine } from "./transcript.ts"

/**
 * OpenCode keeps every session in `opencode.db`. Its schema is OpenCode's own, not a public one: a
 * query that stops matching fails this profile only (see `listThreads`). OpenCode 2 moved sessions
 * from `session`, `message` and `part` into `session_v2` and `session_message`, copying each one
 * across; while that migration runs a session can be in both, and v2 wins. Once it completes only
 * v2 counts, since deleting a session leaves its legacy copy behind. Child sessions are subagents,
 * which can't be resumed on their own, so only top-level ones are kept.
 */

export const OPENCODE_DB = "opencode.db"

// V2 names a session after its first prompt, and a failed naming leaves it untitled, so the
// prompt stands in, as it does for Claude. Streaming updates a message (a part, before v2), not
// its session.
const CURRENT = `
  SELECT id, directory,
         coalesce(nullif(trim(title), ''), (SELECT json_extract(m.data, '$.text')
           FROM session_message m WHERE m.session_id = s.id AND m.type = 'user'
           ORDER BY m.seq LIMIT 1)) AS title,
         max(time_updated, coalesce((SELECT max(m.time_updated) FROM session_message m
           WHERE m.session_id = s.id), 0)) AS updated_at
  FROM session_v2 s
  WHERE parent_id IS NULL AND time_archived IS NULL AND trim(directory) <> ''`

const LEGACY = `
  SELECT id, directory, title,
         max(time_updated, coalesce((SELECT max(p.time_updated) FROM part p
           WHERE p.session_id = s.id), 0)) AS updated_at
  FROM session s
  WHERE parent_id IS NULL AND time_archived IS NULL AND trim(directory) <> ''`

const UNMIGRATED = ` AND NOT EXISTS (SELECT 1 FROM session_v2 v WHERE v.id = s.id)`

const ONLY = ` AND (id IN (SELECT value FROM json_each(?)) OR updated_at >= ?)`

interface Row {
  id: string
  directory: string
  title: string
  updated_at: number
}

// The db is in WAL mode, and a read-only open needs its -shm, which OpenCode deletes when it closes
// cleanly. With no -shm nothing is writing, so the file can be read as it is. Linux builds of
// SQLite only read `file:` names as URIs when asked, and a data directory may hold `#` or `?`.
function open(path: string): Database {
  const shm = existsSync(`${path}-shm`)
  return new Database(
    shm ? path : `${pathToFileURL(path).href}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  )
}

const hasTable = (db: Database, table: string) =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)

export function opencodeThreads(p: Profile, only?: Only): Thread[] {
  const path = join(p.home, OPENCODE_DB)
  if (!existsSync(path)) return []
  const db = open(path)
  const prefix = threadKey(profileKey(p), "")
  const ids = [...(only?.ids ?? [])].flatMap((k) =>
    k.startsWith(prefix) ? [k.slice(prefix.length)] : [],
  )
  try {
    const v2 = hasTable(db, "session_v2")
    const migrated =
      v2 &&
      hasTable(db, "kv") &&
      db
        .query<{ phase: string | null }, []>(
          `SELECT json_extract(value, '$.phase') AS phase FROM kv WHERE key = 'migration.v1-v2'`,
        )
        .get()?.phase === "completed"
    const queries = [
      ...(v2 ? [CURRENT] : []),
      ...(!migrated && hasTable(db, "session") ? [v2 ? LEGACY + UNMIGRATED : LEGACY] : []),
    ]
    if (!queries.length) throw new Error("OpenCode database has no session tables")
    return queries
      .flatMap((q) =>
        db
          .query<Row, (string | number)[]>(
            `SELECT * FROM (${q}) WHERE trim(coalesce(title, '')) <> ''${only ? ONLY : ""}`,
          )
          .all(...(only ? [JSON.stringify(ids), only.since ?? Number.MAX_SAFE_INTEGER] : [])),
      )
      .map((r) => ({
        sessionId: r.id,
        agent: "opencode" as const,
        profile: profileKey(p),
        home: p.home,
        title: firstLine(r.title),
        cwd: r.directory,
        updatedMs: r.updated_at,
        transcript: path,
      }))
  } finally {
    db.close()
  }
}

const OPENCODE_TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  list: "read",
  edit: "edit",
  write: "edit",
  apply_patch: "edit",
  patch: "edit",
  bash: "run",
  shell: "run",
  grep: "search",
  glob: "search",
  codesearch: "search",
  webfetch: "web",
  websearch: "web",
  task: "agent",
  subagent: "agent",
}

interface Part {
  type: "text" | "tool"
  text: string | null
  tool: string | null
}

/**
 * A run of one message's text parts, or of its tool calls, so a reply that talks, calls tools and
 * talks again keeps that order. Holds tool names, never their inputs, outputs or reasoning.
 */
export interface OpencodeRecord {
  fromUser: boolean
  parts: Part[]
}

export function opencodeTools(r: OpencodeRecord): ToolKind[] {
  return r.parts
    .filter((p) => p.type === "tool")
    .map((p) => OPENCODE_TOOL_KINDS[p.tool ?? ""] ?? "other")
}

export function opencodeMessage(r: OpencodeRecord): Message | null {
  const text = r.parts
    .flatMap((p) => (p.type === "text" && p.text ? [p.text] : []))
    .join("\n")
    .trim()
  return text ? { fromUser: r.fromUser, text } : null
}

interface Stored {
  id: string
  fromUser: number
}

/** A message's parts, oldest first, skipping synthetic and ignored ones. */
const PARTS = (from: string, data: string, tool: string) => `
  SELECT json_extract(${data}, '$.type') AS type, json_extract(${data}, '$.text') AS text,
         json_extract(${data}, '${tool}') AS tool
  FROM ${from} AND json_valid(${data})
    AND json_extract(${data}, '$.type') IN ('text', 'tool')
    AND coalesce(json_extract(${data}, '$.synthetic'), 0) = 0
    AND coalesce(json_extract(${data}, '$.ignored'), 0) = 0`

// Forks copy inherited messages with new IDs, so seq, rather than ID or creation time, keeps their
// order. An undo hides its message and everything after it.
function* currentMessages(db: Database, sessionId: string): Generator<Stored> {
  const cutoff = db
    .query<{ seq: number | null }, [string]>(
      `SELECT (SELECT seq FROM session_message m
         WHERE m.session_id = s.id AND m.id = json_extract(s.revert, '$.messageID')) AS seq
       FROM session_v2 s WHERE s.id = ?`,
    )
    .get(sessionId)?.seq
  yield* db
    .query<Stored, (string | number)[]>(
      `SELECT id, type = 'user' AS fromUser FROM session_message
       WHERE session_id = ? AND type IN ('user', 'assistant')${cutoff == null ? "" : " AND seq < ?"}
       ORDER BY seq DESC`,
    )
    .iterate(sessionId, ...(cutoff == null ? [] : [cutoff]))
}

function currentParts(db: Database, m: Stored): Part[] {
  if (m.fromUser)
    return db
      .query<Part, [string]>(
        `SELECT 'text' AS type, json_extract(data, '$.text') AS text, NULL AS tool
         FROM session_message WHERE id = ?`,
      )
      .all(m.id)
  return db
    .query<Part, [string]>(
      `${PARTS("session_message m, json_each(m.data, '$.content') c WHERE m.id = ?", "c.value", "$.name")}
       ORDER BY CAST(c.key AS INTEGER)`,
    )
    .all(m.id)
}

interface Revert {
  message: string | null
  part: string | null
}

// Legacy IDs ascend with creation. An undo at a part keeps its message's earlier parts.
function* legacyMessages(db: Database, sessionId: string, revert?: Revert): Generator<Stored> {
  const bound = revert?.message ? ` AND id ${revert.part ? "<=" : "<"} ?` : ""
  yield* db
    .query<Stored, string[]>(
      `SELECT id, json_extract(data, '$.role') = 'user' AS fromUser FROM message WHERE session_id = ? AND json_valid(data)
         AND json_extract(data, '$.role') IN ('user', 'assistant')
         AND NOT (json_extract(data, '$.role') = 'assistant'
           AND coalesce(json_extract(data, '$.summary'), 0) = 1)${bound}
       ORDER BY time_created DESC, id DESC`,
    )
    .iterate(sessionId, ...(revert?.message ? [revert.message] : []))
}

function legacyParts(db: Database, m: Stored, revert?: Revert): Part[] {
  const bound = m.id === revert?.message && revert.part ? " AND id < ?" : ""
  return db
    .query<Part, string[]>(
      `${PARTS("part WHERE message_id = ?", "data", "$.tool")}${bound} ORDER BY id`,
    )
    .all(m.id, ...(bound ? [revert!.part!] : []))
    .filter((p) => p.type === "text" || !m.fromUser)
}

/**
 * The session's last messages, oldest first, with at most `bytes` of text, and whether older ones
 * exist. Unlike a transcript's tail, only the text counts: an attachment is stored inline, and a
 * pasted image would otherwise hide everything before it.
 */
export function opencodeRecords(
  thread: Thread,
  bytes: number,
): { records: OpencodeRecord[]; more: boolean } {
  const db = open(thread.transcript)
  try {
    const v2 =
      hasTable(db, "session_v2") &&
      !!db.query("SELECT 1 FROM session_v2 WHERE id = ?").get(thread.sessionId)
    const revert = v2
      ? undefined
      : (db
          .query<Revert, [string]>(
            `SELECT json_extract(revert, '$.messageID') AS message,
                    json_extract(revert, '$.partID') AS part FROM session WHERE id = ?`,
          )
          .get(thread.sessionId) ?? undefined)
    const records: OpencodeRecord[] = []
    let left = bytes
    for (const m of v2
      ? currentMessages(db, thread.sessionId)
      : legacyMessages(db, thread.sessionId, revert)) {
      const parts = v2 ? currentParts(db, m) : legacyParts(db, m, revert)
      left -= parts.reduce((n, p) => n + Buffer.byteLength(p.text ?? ""), 0)
      if (left < 0) return { records: records.toReversed(), more: true }
      const runs: OpencodeRecord[] = []
      for (const part of parts) {
        const run = runs.at(-1)
        if (run?.parts[0]!.type === part.type) run.parts.push(part)
        else runs.push({ fromUser: !!m.fromUser, parts: [part] })
      }
      records.push(...runs.toReversed())
    }
    return { records: records.toReversed(), more: false }
  } finally {
    db.close()
  }
}
