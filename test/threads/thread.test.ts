import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { claudeMessage, claudeSummary, claudeTools } from "~/threads/claude.ts"
import { CODEX_STATE_DB, codexMessage, codexTools } from "~/threads/codex.ts"
import { listThreads, preview, previewAt } from "~/threads/thread.ts"
import { headRecords, readTailRecords, tailRecords } from "~/threads/transcript.ts"

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
  const endsPath = join(dir, "ends.jsonl")
  writeFileSync(endsPath, jsonl({ n: 1 }, { n: 2 }, { n: 3 }) + '{"n":4')

  test("drop the line the cut lands in, and an unfinished last line", () => {
    expect(headRecords(endsPath, 1 << 20)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
    expect(headRecords(endsPath, 12)).toEqual([{ n: 1 }])
    expect(tailRecords(endsPath, 15)).toEqual([{ n: 3 }])
  })

  test("compressed and plain byte windows match, including UTF-8 cuts and malformed lines", () => {
    const plain = join(dir, "unicode.jsonl")
    const compressed = join(dir, "unicode-compressed.jsonl")
    const text = jsonl({ text: "hello 🌸" }, { text: "日本語" }) + '\nnot json\n{"n":'
    writeFileSync(plain, text)
    writeFileSync(`${compressed}.zst`, Bun.zstdCompressSync(Buffer.from(text)))
    for (let bytes = 1; bytes <= Buffer.byteLength(text) + 1; bytes++) {
      expect(headRecords(compressed, bytes)).toEqual(headRecords(plain, bytes))
      expect(readTailRecords(compressed, bytes)).toEqual(readTailRecords(plain, bytes))
      expect(tailRecords(`${compressed}.zst`, bytes)).toEqual(tailRecords(plain, bytes))
    }
    expect(tailRecords(compressed, 1 << 20)).toEqual([{ text: "hello 🌸" }, { text: "日本語" }])
  })

  test("prefer the plain sibling for either path spelling", () => {
    const path = join(dir, "siblings.jsonl")
    writeFileSync(path, jsonl({ version: "new" }))
    writeFileSync(`${path}.zst`, Bun.zstdCompressSync(Buffer.from(jsonl({ version: "old" }))))
    for (const name of [path, `${path}.zst`]) {
      expect(tailRecords(name, 1024)).toEqual([{ version: "new" }])
    }
  })

  test("surface missing and corrupt compressed files", () => {
    expect(() => readTailRecords(join(dir, "missing.jsonl"), 1024)).toThrow()
    const path = join(dir, "corrupt.jsonl.zst")
    writeFileSync(path, "not zstd")
    expect(() => readTailRecords(path, 1024)).toThrow()
  })

  test("do not use a compressed sibling when the plain file fails to read", () => {
    const path = join(dir, "directory.jsonl")
    mkdirSync(path)
    writeFileSync(`${path}.zst`, Bun.zstdCompressSync(Buffer.from(jsonl({ n: 1 }))))
    expect(() => readTailRecords(path, 1024)).toThrow()
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

describe("tool kinds", () => {
  const toolUse = (...names: string[]) => ({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "on it" },
        ...names.map((name) => ({ type: "tool_use", name })),
      ],
    },
  })
  const codexCall = (type: string, name?: string, input?: string) => ({
    type: "response_item",
    payload: { type, name, input },
  })

  test("claude tools by name, unknown ones as other", () => {
    expect(
      claudeTools(toolUse("Read", "Edit", "Bash", "Grep", "WebFetch", "Agent", "Skill")),
    ).toEqual(["read", "edit", "run", "search", "web", "agent", "other"])
    expect(claudeTools({ ...toolUse("Bash"), isSidechain: true })).toEqual([])
  })

  test("codex calls, counting each tool inside a code-mode exec", () => {
    const exec =
      'await tools.exec_command({cmd:"ls"}); await tools.apply_patch("x"); tools.web__run({})'
    expect(codexTools(codexCall("custom_tool_call", "exec", exec))).toEqual(["run", "edit", "web"])
    expect(codexTools(codexCall("custom_tool_call", "exec", "text(1)"))).toEqual(["run"])
    expect(codexTools(codexCall("function_call", "spawn_agent"))).toEqual(["agent"])
    expect(codexTools(codexCall("local_shell_call"))).toEqual(["run"])
    expect(codexTools(codexCall("function_call_output"))).toEqual([])
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

  test("reads only the sessions asked for, plus any updated since a time", () => {
    const ids = (only: Parameters<typeof listThreads>[1]) =>
      listThreads(profiles, only).threads.map((t) => t.sessionId)
    expect(ids({ ids: new Set(["codex-work:c-old", "claude-personal:s1"]) })).toEqual([
      "s1",
      "c-old",
    ])
    expect(ids({ ids: new Set(["codex-work:c-old"]), since: 2500 })).toEqual([
      "c-user",
      "s1",
      "c-old",
    ])
    // A session id asked for in one profile doesn't bring it in from another
    expect(ids({ ids: new Set(["claude-personal:c-old"]) })).toEqual([])
    // Asking for a session doesn't bring back threads the listing leaves out
    expect(ids({ ids: new Set(["codex-work:c-sub", "codex-work:c-archived"]) })).toEqual([])
  })

  test("previews the last messages, oldest first", () => {
    const [codex, claude] = listThreads(profiles).threads
    expect(preview(codex!, 1)).toEqual([{ fromUser: false, text: "hi" }])
    expect(preview(claude!, 5)).toEqual([
      { fromUser: true, text: "hello claude" },
      { fromUser: false, text: "hey" },
    ])
  })

  test("reads compression and resumption changes after a thread was listed", () => {
    const path = join(dir, "changing.jsonl")
    const text = jsonl(
      codexTurn("user", "hello"),
      { type: "response_item", payload: { type: "function_call", name: "exec_command" } },
      codexTurn("assistant", "done"),
    )
    const thread = { ...listThreads(profiles).threads[0]!, transcript: path }
    writeFileSync(path, text)
    const expected = previewAt(thread, 0)
    expect(expected).toEqual({
      turns: [
        { fromUser: true, text: "hello" },
        { tools: { run: 1 } },
        { fromUser: false, text: "done" },
      ],
      more: false,
    })
    writeFileSync(`${path}.zst`, Bun.zstdCompressSync(Buffer.from(text)))
    rmSync(path)
    expect(previewAt(thread, 0)).toEqual(expected)
    expect(previewAt({ ...thread, transcript: `${path}.zst` }, 0)).toEqual(expected)
    writeFileSync(path, text + jsonl(codexTurn("user", "again")))
    expect(preview(thread, 1)).toEqual([{ fromUser: true, text: "again" }])
  })

  test("compressed preview pagination uses decompressed bytes", () => {
    const path = join(dir, "compressed-long.jsonl")
    const text = jsonl(
      codexTurn("user", "first"),
      { type: "padding", text: "x".repeat(1 << 20) },
      codexTurn("assistant", "last"),
    )
    const compressed = Bun.zstdCompressSync(Buffer.from(text))
    expect(compressed.length).toBeLessThan(1 << 20)
    writeFileSync(`${path}.zst`, compressed)
    const thread = { ...listThreads(profiles).threads[0]!, transcript: path }
    expect(previewAt(thread, 0)).toEqual({
      turns: [{ fromUser: false, text: "last" }],
      more: true,
    })
    expect(previewAt(thread, 1)).toEqual({
      turns: [
        { fromUser: true, text: "first" },
        { fromUser: false, text: "last" },
      ],
      more: false,
    })
  })

  test("previews a run of tool calls as one turn, counted by kind", () => {
    const path = join(dir, "tools.jsonl")
    const tool = (...names: string[]) => ({
      type: "assistant",
      message: { content: names.map((name) => ({ type: "tool_use", name })) },
    })
    writeFileSync(
      path,
      jsonl(user("go"), tool("Read"), tool("Bash", "Bash"), assistant("done"), tool("Edit")),
    )
    const thread = { ...listThreads(profiles).threads[1]!, transcript: path }
    expect(preview(thread, 9)).toEqual([
      { fromUser: true, text: "go" },
      { tools: { read: 1, run: 2 } },
      { fromUser: false, text: "done" },
      { tools: { edit: 1 } },
    ])
  })

  test("previewAt reads twice as far back at each depth, and says when there's more", () => {
    const path = join(dir, "long.jsonl")
    writeFileSync(path, jsonl(...Array.from({ length: 100 }, (_, i) => user(`turn ${i}`))))
    const thread = { ...listThreads(profiles).threads[1]!, transcript: path }
    const at = (depth: number) => {
      const { turns, more } = previewAt(thread, depth)
      return [turns.length, "text" in turns[0]! && turns[0].text, more]
    }
    expect(at(0)).toEqual([40, "turn 60", true])
    expect(at(1)).toEqual([80, "turn 20", true])
    expect(at(2)).toEqual([100, "turn 0", false])
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

  test("reads codex's WAL db after codex closed it and its -shm is gone", () => {
    const home = join(dir, "codex-closed")
    mkdirSync(home)
    const wal = new Database(join(home, CODEX_STATE_DB))
    wal.run("PRAGMA journal_mode=WAL")
    wal.run(`CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, title TEXT, name TEXT,
      updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER, thread_source TEXT)`)
    wal.run("INSERT INTO threads VALUES ('c-wal', ?, '/p', 'from wal', null, 0, 1, 0, 'user')", [
      rollout,
    ])
    // As codex leaves it after a clean close: everything in the db, no -wal or -shm
    wal.run("PRAGMA wal_checkpoint(TRUNCATE)")
    wal.close()
    for (const side of ["-wal", "-shm"]) rmSync(join(home, CODEX_STATE_DB + side), { force: true })
    const { threads, failed } = listThreads([{ kind: "codex", name: "closed", home }])
    expect(failed).toEqual([])
    expect(threads.map((t) => t.sessionId)).toEqual(["c-wal"])
  })

  test("a missing home has no threads", () => {
    expect(listThreads([{ kind: "codex", name: "x", home: join(dir, "nope") }])).toEqual({
      threads: [],
      failed: [],
    })
  })
})
