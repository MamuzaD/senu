import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { claudeMessage, claudeSummary } from "~/threads/claude.ts"
import { CODEX_STATE_DB, codexMessage } from "~/threads/codex.ts"
import { listThreads, preview } from "~/threads/thread.ts"
import { headRecords, tailRecords } from "~/threads/transcript.ts"

const dir = mkdtempSync(join(tmpdir(), "senu-threads-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const jsonl = (...rs: object[]) => rs.map((r) => JSON.stringify(r) + "\n").join("")

const user = (content: unknown, extra: object = {}) => ({
  type: "user",
  cwd: "/p",
  message: { role: "user", content },
  ...extra,
})
const assistant = (text: string, extra: object = {}) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
  ...extra,
})
const codexTurn = (role: string, text: string) => ({
  type: "response_item",
  payload: {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  },
})

describe("transcript ends", () => {
  const path = join(dir, "ends.jsonl")
  writeFileSync(path, jsonl({ n: 1 }, { n: 2 }, { n: 3 }) + '{"n":4')

  test("drop the line the cut lands in, and an unfinished last line", () => {
    expect(headRecords(path, 1 << 20)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(headRecords(path, 12)).toEqual([{ n: 1 }])
    expect(tailRecords(path, 15)).toEqual([{ n: 3 }])
  })
})

describe("claude messages", () => {
  test("keep what people wrote and said", () => {
    expect(claudeMessage(user("  hi  "))).toEqual({ fromUser: true, text: "hi" })
    expect(
      claudeMessage(
        user([
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ]),
      ),
    ).toEqual({ fromUser: true, text: "a\nb" })
    expect(claudeMessage(assistant("done"))).toEqual({ fromUser: false, text: "done" })
  })

  test("skip tool results, injected context, sidechains, compact summaries and API errors", () => {
    expect(
      claudeMessage(user("This session is being continued", { isCompactSummary: true })),
    ).toBeNull()
    expect(claudeMessage(user([{ type: "tool_result", content: "x" }]))).toBeNull()
    expect(claudeMessage(user("<command-name>/model</command-name>"))).toBeNull()
    expect(claudeMessage(user("skill text", { isMeta: true }))).toBeNull()
    expect(claudeMessage(user("hi", { isSidechain: true }))).toBeNull()
    expect(claudeMessage(assistant("API Error: lost", { isApiErrorMessage: true }))).toBeNull()
    expect(claudeMessage({ type: "ai-title", aiTitle: "t" })).toBeNull()
  })
})

describe("claude summary", () => {
  test("takes the newest ai-title", () => {
    const tail = [
      { type: "ai-title", aiTitle: "old" },
      { type: "user", cwd: "/a" },
      { type: "ai-title", aiTitle: "new" },
      { type: "user", cwd: "/b" },
    ]
    expect(claudeSummary([], tail)).toEqual({ title: "new", cwd: "/a" })
  })

  test("keeps the cwd the session started in after a cd", () => {
    const head = [user("hi", { cwd: "/repo" }), user("more", { cwd: "/repo/pkg" })]
    expect(claudeSummary(head, [user("bye", { cwd: "/repo/pkg" })])?.cwd).toBe("/repo")
  })

  test("falls back to the first prompt's first line, and the head's cwd", () => {
    const head = [user("<command-name>/model</command-name>"), user("fix it\nplease")]
    expect(claudeSummary(head, [{ type: "mode" }])).toEqual({ title: "fix it", cwd: "/p" })
  })

  test("is null for a session nobody spoke in", () => {
    expect(claudeSummary([user("<command-name>/model</command-name>")], [])).toBeNull()
  })
})

describe("codex messages", () => {
  test("keep conversation turns", () => {
    expect(codexMessage(codexTurn("user", "hi"))).toEqual({ fromUser: true, text: "hi" })
    expect(codexMessage(codexTurn("assistant", "ok"))).toEqual({ fromUser: false, text: "ok" })
  })

  test("skip injected context, developer turns and non-messages", () => {
    expect(codexMessage(codexTurn("user", "<environment_context>…"))).toBeNull()
    expect(codexMessage(codexTurn("user", "# AGENTS.md instructions for /p"))).toBeNull()
    expect(codexMessage(codexTurn("developer", "rules"))).toBeNull()
    expect(codexMessage({ type: "response_item", payload: { type: "reasoning" } })).toBeNull()
  })
})

describe("listThreads", () => {
  const codexHome = join(dir, "codex")
  const claudeHome = join(dir, "claude")
  mkdirSync(codexHome)
  mkdirSync(join(claudeHome, "projects", "-p", "s1", "subagents"), { recursive: true })

  const rollout = join(codexHome, "rollout.jsonl")
  writeFileSync(rollout, jsonl(codexTurn("user", "hello codex"), codexTurn("assistant", "hi")))
  const db = new Database(join(codexHome, CODEX_STATE_DB))
  db.run(`CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT,
    updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER, thread_source TEXT)`)
  const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
  insert.run("c-user", rollout, "/p", "first line\nsecond", null, 0, 3000, 0, "user")
  insert.run("c-named", rollout, "/p", "prompt", "Generated name", 0, 2000, 0, "user")
  insert.run("c-old", rollout, "/p", "from before thread_source", null, 1, null, 0, null)
  insert.run("c-sub", rollout, "/p", "sub", null, 0, 9000, 0, "subagent")
  insert.run("c-guard", rollout, "/p", "Guardian review", null, 0, 9000, 0, "guardian_review")
  insert.run("c-archived", rollout, "/p", "gone", null, 0, 9000, 1, "user")
  insert.run("c-empty", rollout, "/p", "", null, 0, 9000, 0, "user")
  db.close()

  const session = join(claudeHome, "projects", "-p", "s1.jsonl")
  writeFileSync(session, jsonl(user("hello claude"), assistant("hey")))
  utimesSync(session, 2.5, 2.5)
  writeFileSync(
    join(claudeHome, "projects", "-p", "s1", "subagents", "a.jsonl"),
    jsonl(user("sub")),
  )
  writeFileSync(join(claudeHome, "projects", "-p", "empty.jsonl"), "")

  const profiles = [
    { kind: "codex" as const, name: "work", home: codexHome },
    { kind: "claude" as const, name: "personal", home: claudeHome },
  ]

  test("merges user threads from every profile, newest first", () => {
    const { threads, failed } = listThreads(profiles)
    expect(failed).toEqual([])
    expect(threads.map((t) => [t.sessionId, t.profile, t.title])).toEqual([
      ["c-user", "codex-work", "first line"],
      ["s1", "claude-personal", "hello claude"],
      ["c-named", "codex-work", "Generated name"],
      ["c-old", "codex-work", "from before thread_source"],
    ])
    expect(threads[1]).toMatchObject({
      agent: "claude",
      cwd: "/p",
      home: claudeHome,
      transcript: session,
    })
  })

  test("previews the last messages, oldest first", () => {
    const [codex, claude] = listThreads(profiles).threads
    expect(preview(codex!, 1)).toEqual([{ fromUser: false, text: "hi" }])
    expect(preview(claude!, 5)).toEqual([
      { fromUser: true, text: "hello claude" },
      { fromUser: false, text: "hey" },
    ])
  })

  test("reports a profile it can't read and lists the rest", () => {
    const broken = join(dir, "broken")
    mkdirSync(broken)
    new Database(join(broken, CODEX_STATE_DB)).close()
    const { threads, failed } = listThreads([
      { kind: "codex", name: "broken", home: broken },
      profiles[1]!,
    ])
    expect(threads.map((t) => t.sessionId)).toEqual(["s1"])
    expect(failed).toEqual([{ profile: "codex-broken", error: expect.stringContaining("threads") }])
  })

  test("a missing home has no threads", () => {
    expect(listThreads([{ kind: "codex", name: "x", home: join(dir, "nope") }])).toEqual({
      threads: [],
      failed: [],
    })
  })
})
