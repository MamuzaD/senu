import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { opencodeHome, type Profile } from "~/config.ts"
import { OPENCODE_DB } from "~/threads/opencode.ts"
import { launchFor } from "~/threads/resume.ts"
import { listThreads, preview, previewAt } from "~/threads/thread.ts"

const dir = mkdtempSync(join(tmpdir(), "senu-opencode-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fixture(name: string, wal = false) {
  const home = join(dir, name, "opencode")
  mkdirSync(home, { recursive: true })
  const path = join(home, OPENCODE_DB)
  const db = new Database(path)
  if (wal) db.run("PRAGMA journal_mode=WAL")
  db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT,
    title TEXT, time_updated INTEGER, time_archived INTEGER, revert TEXT)`)
  db.run(
    `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)`,
  )
  db.run(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
    time_created INTEGER, time_updated INTEGER, data TEXT)`)
  db.run(
    "CREATE INDEX message_session_time_created_id_idx ON message(session_id, time_created, id)",
  )
  db.run("CREATE INDEX part_message_id_id_idx ON part(message_id, id)")
  db.run("CREATE INDEX part_session_idx ON part(session_id)")
  const session = (
    id: string,
    at = 1000,
    parent: string | null = null,
    archived: number | null = null,
  ) =>
    db.run("INSERT INTO session VALUES (?, ?, '/project', ?, ?, ?, NULL)", [
      id,
      parent,
      `Title ${id}\nmore`,
      at,
      archived,
    ])
  const message = (
    id: string,
    role: string,
    parts: object[],
    at: number,
    extra = {},
    sid = "ses_a",
  ) => {
    db.run("INSERT INTO message VALUES (?, ?, ?, ?)", [
      id,
      sid,
      at,
      JSON.stringify({ role, ...extra }),
    ])
    parts.forEach((part, i) =>
      db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)", [
        `${id}_p${i}`,
        id,
        sid,
        at + i,
        at + i,
        JSON.stringify(part),
      ]),
    )
  }
  const profile: Profile = { kind: "opencode", name, home }
  const thread = () => listThreads([profile]).threads[0]!
  return { db, home, path, session, message, profile, thread }
}

describe("OpenCode threads", () => {
  test.each([false, true])("streaming a part updates the thread with WAL=%s", (wal) => {
    const f = fixture(`revision-${wal}`, wal)
    f.session("ses_a")
    f.message("msg_1", "assistant", [{ type: "text", text: "first" }], 1)
    f.db.run("UPDATE part SET data = ?, time_updated = 5678", [
      JSON.stringify({ type: "text", text: "streamed response" }),
    ])
    const after = f.thread()
    expect(after.updatedMs).toBe(5678)
    expect(preview(after, 40)).toEqual([{ fromUser: false, text: "streamed response" }])
    f.db.close()
  })

  test("lists user sessions, newest first, excluding children, archived and empty paths", () => {
    const f = fixture("list")
    f.session("ses_a", 1000)
    f.session("ses_b", 2000)
    f.session("ses_child", 9000, "ses_a")
    f.session("ses_archived", 9000, null, 1)
    f.session("ses_empty", 9000)
    f.db.run("UPDATE session SET directory = '' WHERE id = 'ses_empty'")
    f.db.close()
    const got = listThreads([f.profile])
    expect(got.failed).toEqual([])
    expect(got.threads.map((t) => t.sessionId)).toEqual(["ses_b", "ses_a"])
    expect(got.threads[0]).toMatchObject({
      agent: "opencode",
      profile: "opencode-list",
      title: "Title ses_b",
      cwd: "/project",
      home: f.home,
      transcript: f.path,
      updatedMs: 2000,
    })
    expect(readdirSync(f.home)).toEqual([OPENCODE_DB])
  })

  test("scopes IDs to their profile and keeps recent sessions", () => {
    const f = fixture("scope")
    f.session("ses_a", 1000)
    f.session("ses_b", 2000)
    f.db.close()
    const list = (ids: string[], since?: number) =>
      listThreads([f.profile], {
        ids: new Set(ids),
        ...(since !== undefined && { since }),
      }).threads.map((t) => t.sessionId)
    expect(list(["opencode-scope:ses_a"])).toEqual(["ses_a"])
    expect(list(["opencode-other:ses_a"])).toEqual([])
    expect(list(["opencode-scope:ses_a"], 2000)).toEqual(["ses_b", "ses_a"])
  })

  test("reads uncheckpointed WAL updates without modifying the database", () => {
    const f = fixture("wal", true)
    f.session("ses_a")
    expect(f.thread().sessionId).toBe("ses_a")
    f.session("ses_b", 2000)
    expect(f.thread().sessionId).toBe("ses_b")
    f.db.close()
    const before = readdirSync(f.home)
    expect(f.thread().sessionId).toBe("ses_b")
    expect(readdirSync(f.home)).toEqual(before)
  })

  test("missing data is empty, and an incompatible database fails only its profile", () => {
    const missing: Profile = { kind: "opencode", name: "missing", home: join(dir, "missing") }
    expect(listThreads([missing])).toEqual({ threads: [], failed: [] })
    expect(existsSync(missing.home)).toBe(false)
    const f = fixture("broken")
    f.db.run("DROP TABLE session")
    f.db.close()
    expect(listThreads([f.profile, missing]).failed).toEqual([
      { profile: "opencode-broken", error: expect.stringContaining("session") },
    ])
  })

  test("supports URI-sensitive characters in the data directory", () => {
    const f = fixture("space # ? %")
    f.session("ses_a")
    f.db.close()
    expect(f.thread().sessionId).toBe("ses_a")
  })
})

describe("OpenCode previews", () => {
  test("keeps conversation order and tool groups, excluding injected and hidden content", () => {
    const f = fixture("preview")
    f.session("ses_a")
    f.session("ses_b", 0)
    f.message(
      "msg_1",
      "user",
      [
        { type: "text", text: "hello" },
        { type: "text", text: "injected", synthetic: true },
        { type: "text", text: "hidden", ignored: true },
      ],
      1,
    )
    f.message(
      "msg_2",
      "assistant",
      [
        { type: "reasoning", text: "private" },
        { type: "text", text: "on it" },
        { type: "tool", tool: "read", state: { output: "private output" } },
        { type: "tool", tool: "bash" },
        { type: "tool", tool: "bash" },
        { type: "text", text: "done" },
        { type: "text", text: "really" },
      ],
      10,
    )
    f.message("msg_3", "assistant", [{ type: "text", text: "summary" }], 30, { summary: true })
    f.message("msg_3b", "user", [{ type: "text", text: "follow up" }], 35, {
      summary: { title: "generated title", diffs: [] },
    })
    f.message("msg_4", "system", [{ type: "text", text: "system" }], 40)
    f.message("msg_5", "user", [{ type: "text", text: "other session" }], 50, {}, "ses_b")
    f.db.close()
    expect(preview(f.thread(), 40)).toEqual([
      { fromUser: true, text: "hello" },
      { fromUser: false, text: "on it" },
      { tools: { read: 1, run: 2 } },
      { fromUser: false, text: "done\nreally" },
      { fromUser: true, text: "follow up" },
    ])
    expect(preview(f.thread(), 1)).toEqual([{ fromUser: true, text: "follow up" }])
  })

  test("pages older turns without using database file size as transcript length", () => {
    const f = fixture("paging")
    f.session("ses_a")
    for (let i = 0; i < 100; i++)
      f.message(
        `msg_${String(i).padStart(3, "0")}`,
        "user",
        [{ type: "text", text: `turn ${i}` }],
        i,
      )
    f.db.close()
    expect(previewAt(f.thread(), 0)).toMatchObject({ turns: expect.any(Array), more: true })
    expect(previewAt(f.thread(), 0).turns).toHaveLength(40)
    expect(previewAt(f.thread(), 1).turns).toHaveLength(80)
    expect(previewAt(f.thread(), 2)).toMatchObject({ more: false })
    expect(previewAt(f.thread(), 2).turns[0]).toEqual({ fromUser: true, text: "turn 0" })
  })

  test("respects full-message and partial-message revert markers", () => {
    const f = fixture("revert")
    f.session("ses_a")
    f.message("msg_1", "user", [{ type: "text", text: "keep" }], 1)
    f.message(
      "msg_2",
      "assistant",
      [
        { type: "text", text: "kept part" },
        { type: "text", text: "undone part" },
      ],
      10,
    )
    f.message("msg_3", "user", [{ type: "text", text: "undone message" }], 30)
    f.db.run("UPDATE session SET revert = ?", [JSON.stringify({ messageID: "msg_2" })])
    expect(preview(f.thread(), 40)).toEqual([{ fromUser: true, text: "keep" }])
    f.db.run("UPDATE session SET revert = ?", [
      JSON.stringify({ messageID: "msg_2", partID: "msg_2_p1" }),
    ])
    expect(preview(f.thread(), 40)).toEqual([
      { fromUser: true, text: "keep" },
      { fromUser: false, text: "kept part" },
    ])
    f.db.close()
  })

  test("bounds text reads by the byte budget and expands on a larger read", () => {
    const f = fixture("budget")
    f.session("ses_a")
    f.message("msg_1", "user", [{ type: "text", text: "x".repeat(200) }], 1)
    f.db.close()
    expect(preview(f.thread(), 40, 100)).toEqual([])
    expect(preview(f.thread(), 40, 300)).toEqual([{ fromUser: true, text: "x".repeat(200) }])
  })
})

describe("OpenCode resume", () => {
  test("another profile gets a private server on its data root", () => {
    expect(
      launchFor({
        agent: "opencode",
        sessionId: "ses_a",
        cwd: "/project",
        home: "/data root/opencode",
      }),
    ).toEqual({
      argv: ["opencode", "--standalone", "--session", "ses_a"],
      cwd: "/project",
      env: { XDG_DATA_HOME: "/data root" },
    })
  })

  test("the default profile uses the background service", () => {
    expect(
      launchFor({ agent: "opencode", sessionId: "ses_a", cwd: "/project", home: opencodeHome() })
        .argv,
    ).toEqual(["opencode", "--session", "ses_a"])
  })
})
