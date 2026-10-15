import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Profile } from "~/config.ts"
import { OPENCODE_DB } from "~/threads/opencode.ts"
import { listThreads, preview, previewAt } from "~/threads/thread.ts"

const root = mkdtempSync(join(tmpdir(), "senu-opencode-v2-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

interface SessionOptions {
  parent?: string | null
  archived?: number | null
  directory?: string
  title?: string
  revert?: object | null
}

function fixture(name: string, { legacy = true, wal = false } = {}) {
  const home = join(root, name, "opencode")
  mkdirSync(home, { recursive: true })
  const path = join(home, OPENCODE_DB)
  const db = new Database(path)
  if (wal) db.run("PRAGMA journal_mode=WAL")
  db.run(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
    time_updated INTEGER, time_archived INTEGER, revert TEXT
  )`)
  db.run(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
    time_created INTEGER, time_updated INTEGER, data TEXT
  )`)
  db.run("CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq)")
  db.run(
    "CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id, type, seq)",
  )
  db.run(
    "CREATE INDEX session_message_session_created_id_idx ON session_message(session_id, time_created, id)",
  )
  if (legacy) {
    db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT,
      title TEXT, time_updated INTEGER, time_archived INTEGER, revert TEXT)`)
    db.run(
      `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)`,
    )
    db.run(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT)`)
  }

  const v2Session = (id: string, at = 1000, options: SessionOptions = {}) =>
    db.run("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id,
      options.parent ?? null,
      options.directory ?? "/project",
      options.title ?? `Title ${id}\nmore`,
      at,
      options.archived ?? null,
      options.revert ? JSON.stringify(options.revert) : null,
    ])
  const legacySession = (id: string, at = 1000, options: SessionOptions = {}) => {
    if (!legacy) throw new Error("legacy schema is disabled")
    db.run("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id,
      options.parent ?? null,
      options.directory ?? "/legacy-project",
      options.title ?? `Legacy ${id}\nmore`,
      at,
      options.archived ?? null,
      options.revert ? JSON.stringify(options.revert) : null,
    ])
  }
  const v2Message = (
    id: string,
    sessionId: string,
    type: string,
    seq: number,
    data: object,
    at = seq,
  ) =>
    db.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)", [
      id,
      sessionId,
      type,
      seq,
      at,
      at + 1,
      JSON.stringify(data),
    ])
  const user = (id: string, sessionId: string, seq: number, text: string, at = seq) =>
    v2Message(id, sessionId, "user", seq, { time: { created: at }, text }, at)
  const assistant = (
    id: string,
    sessionId: string,
    seq: number,
    content: object[],
    at = seq,
    extra: object = {},
  ) => v2Message(id, sessionId, "assistant", seq, { time: { created: at }, content, ...extra }, at)
  const legacyMessage = (id: string, sessionId: string, text: string, at = 1) => {
    if (!legacy) throw new Error("legacy schema is disabled")
    db.run("INSERT INTO message VALUES (?, ?, ?, ?)", [
      `${id}_message`,
      sessionId,
      at,
      JSON.stringify({ role: "user" }),
    ])
    db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
      `${id}_part`,
      `${id}_message`,
      sessionId,
      at,
      at,
      JSON.stringify({ type: "text", text }),
    ])
  }
  const profile: Profile = { kind: "opencode", name, home }
  const listed = () => listThreads([profile]).threads
  const thread = (id: string) => listed().find((item) => item.sessionId === id)!
  return {
    db,
    home,
    path,
    profile,
    v2Session,
    legacySession,
    v2Message,
    user,
    assistant,
    legacyMessage,
    listed,
    thread,
  }
}

describe("OpenCode v2 threads", () => {
  test("keeps unnamed conversations visible while title generation is pending or fails", () => {
    const f = fixture("untitled", { legacy: false })
    for (const [id, title] of [
      ["null-title", null],
      ["blank-title", "   "],
      ["empty-tab", null],
      ["archived", null],
      ["child", null],
      ["missing-directory", null],
    ] as const) {
      f.v2Session(id, 1000)
      f.db.run("UPDATE session_v2 SET title = ? WHERE id = ?", [title, id])
      if (id !== "empty-tab") f.user(`${id}-user`, id, 1, `question ${id}`)
    }
    f.assistant("null-answer", "null-title", 2, [{ type: "text", text: "answer" }])
    f.db.run("UPDATE session_v2 SET time_archived = 1 WHERE id = 'archived'")
    f.db.run("UPDATE session_v2 SET parent_id = 'null-title' WHERE id = 'child'")
    f.db.run("UPDATE session_v2 SET directory = '' WHERE id = 'missing-directory'")
    f.db.close()

    expect(listThreads([f.profile]).failed).toEqual([])
    expect(
      f
        .listed()
        .map((t) => [t.sessionId, t.title] as const)
        .toSorted(([a], [b]) => a.localeCompare(b)),
    ).toEqual([
      ["blank-title", "question blank-title"],
      ["null-title", "question null-title"],
    ])
    expect(preview(f.thread("null-title"), 40)).toEqual([
      { fromUser: true, text: "question null-title" },
      { fromUser: false, text: "answer" },
    ])
    expect(
      listThreads([f.profile], {
        ids: new Set(["opencode-untitled:null-title"]),
      }).threads.map((t) => t.sessionId),
    ).toEqual(["null-title"])
  })

  test("lists and previews a v2-only session", () => {
    const f = fixture("fresh", { legacy: false })
    f.v2Session("ses_v2", 2000, { title: "V2 title\nsecond line" })
    f.user("user-a", "ses_v2", 1, "question")
    f.assistant("assistant-a", "ses_v2", 2, [{ type: "text", text: "answer" }])
    f.db.close()

    expect(f.listed()).toMatchObject([
      {
        sessionId: "ses_v2",
        title: "V2 title",
        cwd: "/project",
        updatedMs: 2000,
        transcript: f.path,
      },
    ])
    expect(preview(f.thread("ses_v2"), 40)).toEqual([
      { fromUser: true, text: "question" },
      { fromUser: false, text: "answer" },
    ])
  })

  test("prefers v2 metadata and prevents hidden migrated rows from resurfacing", () => {
    const f = fixture("migration")
    f.legacySession("active", 100)
    f.legacySession("archived", 500)
    f.legacySession("child", 600)
    f.legacySession("empty", 700)
    f.legacySession("legacy-only", 300)
    f.v2Session("active", 200, { title: "V2 title", directory: "/v2-project" })
    f.v2Session("archived", 900, { archived: 1 })
    f.v2Session("child", 1000, { parent: "active" })
    f.v2Session("empty", 1100, { title: "   " })
    f.legacyMessage("legacy-only", "legacy-only", "fallback conversation")
    f.db.close()

    expect(f.listed().map((thread) => thread.sessionId)).toEqual(["legacy-only", "active"])
    expect(f.thread("active")).toMatchObject({
      title: "V2 title",
      cwd: "/v2-project",
      updatedMs: 200,
    })
    expect(preview(f.thread("legacy-only"), 40)).toEqual([
      { fromUser: true, text: "fallback conversation" },
    ])
  })

  test("scopes requested IDs to the profile and includes recent sessions from both schemas", () => {
    const f = fixture("only")
    f.v2Session("v2-old", 100)
    f.legacySession("legacy-old", 200)
    f.v2Session("v2-recent", 300)
    f.legacySession("legacy-recent", 400)
    f.db.close()
    const list = (ids: string[], since?: number) =>
      listThreads([f.profile], {
        ids: new Set(ids),
        ...(since !== undefined && { since }),
      }).threads.map((thread) => thread.sessionId)

    expect(list(["opencode-only:v2-old"])).toEqual(["v2-old"])
    expect(list(["opencode-other:v2-old"])).toEqual([])
    expect(list(["opencode-only:v2-old"], 300)).toEqual(["legacy-recent", "v2-recent", "v2-old"])
  })

  test("completed migration never resurrects deleted sessions from stale legacy rows", () => {
    const f = fixture("completed")
    f.legacySession("deleted", 300)
    f.legacySession("kept", 100)
    f.v2Session("kept", 200)
    f.db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)")
    f.db.run("INSERT INTO kv VALUES ('migration.v1-v2', ?)", [
      JSON.stringify({ phase: "completed" }),
    ])
    f.db.close()
    expect(f.listed().map((t) => t.sessionId)).toEqual(["kept"])
  })

  test("incomplete migration retains sessions that have not been copied yet", () => {
    const f = fixture("incomplete")
    f.legacySession("not-copied", 300)
    f.v2Session("copied", 200)
    f.db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)")
    f.db.run("INSERT INTO kv VALUES ('migration.v1-v2', ?)", [JSON.stringify({ phase: "running" })])
    f.db.close()
    expect(f.listed().map((t) => t.sessionId)).toEqual(["not-copied", "copied"])
  })

  test("uses sequence order and only renders conversation text and tool summaries", () => {
    const f = fixture("content", { legacy: false })
    f.v2Session("ses_content")
    f.user("z-user", "ses_content", 10, "hello", 900)
    f.assistant(
      "a-assistant",
      "ses_content",
      20,
      [
        { type: "reasoning", text: "private reasoning" },
        { type: "step-start", text: "model switched" },
        { type: "text", text: "working", synthetic: true },
        { type: "text", text: "ignored", ignored: true },
        { type: "tool", name: "read", state: { output: "private output" } },
        { type: "tool", name: "shell" },
        { type: "tool", name: "subagent" },
        { type: "tool", name: "patch" },
        { type: "text", text: "done" },
      ],
      1,
    )
    for (const [i, type] of [
      "system",
      "synthetic",
      "idle",
      "model-switched",
      "compaction",
    ].entries())
      f.v2Message(`${type}-row`, "ses_content", type, 30 + i, {
        time: { created: 30 + i },
        text: `${type} text`,
        content: [{ type: "text", text: `${type} content` }],
      })
    f.user("b-user", "ses_content", 60, "follow up", 0)
    f.db.close()

    expect(preview(f.thread("ses_content"), 40)).toEqual([
      { fromUser: true, text: "hello" },
      { tools: { read: 1, run: 1, agent: 1, edit: 1 } },
      { fromUser: false, text: "done" },
      { fromUser: true, text: "follow up" },
    ])
  })

  test("hides a reverted message by its sequence and ignores a missing revert target", () => {
    const f = fixture("revert", { legacy: false })
    f.v2Session("ses_revert", 1000, { revert: { messageID: "m2" } })
    f.user("m1", "ses_revert", 10, "keep", 10)
    f.assistant("m2", "ses_revert", 20, [{ type: "text", text: "reverted" }], 20)
    f.user("m3", "ses_revert", 30, "also reverted", 30)
    f.db.close()

    expect(preview(f.thread("ses_revert"), 40)).toEqual([{ fromUser: true, text: "keep" }])
    f.db = new Database(f.path)
    f.db.run("UPDATE session_v2 SET revert = ? WHERE id = ?", [
      JSON.stringify({ messageID: "missing-message" }),
      "ses_revert",
    ])
    f.db.close()
    expect(preview(f.thread("ses_revert"), 40)).toEqual([
      { fromUser: true, text: "keep" },
      { fromUser: false, text: "reverted" },
      { fromUser: true, text: "also reverted" },
    ])
  })

  test("shows fork-copied messages in the child by sequence without reading the parent", () => {
    const f = fixture("fork", { legacy: false })
    f.v2Session("parent", 500)
    f.v2Session("child", 1000)
    f.db.run("ALTER TABLE session_v2 ADD COLUMN fork_session_id TEXT")
    f.db.run("ALTER TABLE session_v2 ADD COLUMN fork_boundary TEXT")
    f.db.run(
      "UPDATE session_v2 SET fork_session_id = 'parent', fork_boundary = ? WHERE id = 'child'",
      [JSON.stringify({ type: "through", messageID: "parent-message" })],
    )
    f.user("parent-message", "parent", 1, "parent only", 10)
    f.user("copied-z", "child", 1, "copied before fork", 10)
    f.assistant("child-a", "child", 2, [{ type: "text", text: "child reply" }], 900)
    f.user("child-z", "child", 3, "new child prompt", 1000)
    f.db.close()

    expect(f.listed().map((thread) => thread.sessionId)).toEqual(["child", "parent"])
    const child = f.thread("child")
    expect(preview(child, 40)).toEqual([
      { fromUser: true, text: "copied before fork" },
      { fromUser: false, text: "child reply" },
      { fromUser: true, text: "new child prompt" },
    ])
    expect(preview(child, 40).some((turn) => "text" in turn && turn.text === "parent only")).toBe(
      false,
    )
  })

  test("paginates by turn count and stops when the text byte budget is exhausted", () => {
    const f = fixture("paging", { legacy: false })
    f.v2Session("ses_pages")
    for (let i = 0; i < 85; i++) f.user(`user-${i}`, "ses_pages", i + 1, `turn ${i}`)
    f.db.close()

    expect(previewAt(f.thread("ses_pages"), 0).turns).toHaveLength(40)
    expect(previewAt(f.thread("ses_pages"), 0).more).toBe(true)
    expect(previewAt(f.thread("ses_pages"), 1).turns).toHaveLength(80)
    expect(previewAt(f.thread("ses_pages"), 2)).toMatchObject({ more: false })
    expect(previewAt(f.thread("ses_pages"), 2).turns[0]).toEqual({
      fromUser: true,
      text: "turn 0",
    })

    const budget = fixture("budget", { legacy: false })
    budget.v2Session("ses_budget")
    budget.user("long-user", "ses_budget", 1, "é".repeat(80))
    budget.db.close()
    expect(preview(budget.thread("ses_budget"), 40, 100)).toEqual([])
    expect(preview(budget.thread("ses_budget"), 40, 200)).toEqual([
      { fromUser: true, text: "é".repeat(80) },
    ])
  })

  test("streaming a reply updates the thread without touching its session", () => {
    const f = fixture("wal", { legacy: false, wal: true })
    f.v2Session("ses_wal", 1234)
    f.assistant("assistant", "ses_wal", 1, [{ type: "text", text: "first" }])
    f.db.run("UPDATE session_message SET data = ?, time_updated = 5678 WHERE id = ?", [
      JSON.stringify({ time: { created: 1 }, content: [{ type: "text", text: "streamed" }] }),
      "assistant",
    ])
    // Closing the writer checkpoints and drops the WAL on Linux, so compare while it's open
    const files = readdirSync(f.home).toSorted()
    const after = f.thread("ses_wal")

    expect(after.updatedMs).toBe(5678)
    expect(preview(after, 40)).toEqual([{ fromUser: false, text: "streamed" }])
    expect(readdirSync(f.home).toSorted()).toEqual(files)
    f.db.close()
  })
})
