import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { loadConfig } from "~/config.ts"
import { allowedProfiles } from "~/privacy.ts"
import { searchCommand } from "~/search/command.ts"
import { searchThreads } from "~/search/search.ts"

import { cleanup, record, rollout, setup } from "./chats.ts"

afterEach(cleanup)

describe("profile boundary", () => {
  test("known personal sees all; restricted and conflicting signals see only work; unknown fails closed outside a terminal", () => {
    const { config, env } = setup()
    expect(allowedProfiles(config, env)).toHaveLength(3)
    expect(allowedProfiles(config, {}).map((p) => p.name)).toEqual(["work", "work"])
    expect(allowedProfiles(config, {}, undefined, true)).toHaveLength(3)
    expect(
      allowedProfiles(config, { CODEX_HOME: "/unknown" }, undefined, true).map((p) => p.name),
    ).toEqual(["work", "work"])
    const work = { ...env, CLAUDE_CONFIG_DIR: config.profiles[2]!.home }
    expect(allowedProfiles(config, work).map((p) => p.name)).toEqual(["work", "work"])
    expect(allowedProfiles(config, { CODEX_HOME: "/unknown" }).map((p) => p.name)).toEqual([
      "work",
      "work",
    ])
    expect(allowedProfiles(config, work, "personal")).toEqual([])
  })
  test("with nothing restricted, every caller sees every profile", () => {
    const { config } = setup()
    config.privacy = { restricted: [] }
    expect(allowedProfiles(config, {})).toHaveLength(3)
    expect(allowedProfiles(config, { CODEX_HOME: "/unknown" })).toHaveLength(3)
    expect(allowedProfiles(config, {}, "work")).toHaveLength(2)
    expect(loadConfig(join(config.profiles[0]!.home, "missing")).privacy).toEqual({
      restricted: [],
    })
  })
  test("rejects malformed privacy config", () => {
    const { root } = setup()
    const path = join(root, "config.toml")
    for (const raw of [
      "privacy = true",
      '[privacy]\nrestricted = "work"',
      "[privacy]\nrestricted = [1]",
    ]) {
      writeFileSync(path, raw)
      expect(() => loadConfig(path)).toThrow()
    }
  })
})

describe("transcript search", () => {
  test("canonical Codex messages, compressed and archived files, roles, exclusions and bounded excerpts", async () => {
    const { config, env } = setup()
    rollout(config, 0, "plain", [
      { type: "session_meta", payload: { id: "one", source: "cli", cwd: "/repo" } },
      { type: "event_msg", payload: { type: "user_message", message: "needle duplicate" } },
      { timestamp: "2026-11-01T00:00:00Z", ...record("prefix\nNEEDLE  suffix") },
      record("needle assistant", "assistant"),
      { type: "response_item", payload: { type: "function_call_output", output: "needle tool" } },
    ])
    const compressed = rollout(
      config,
      0,
      "compressed",
      [
        { type: "session_meta", payload: { id: "two" } },
        {
          timestamp: "2026-11-02T00:00:00Z",
          ...record("x".repeat(1000) + "needle" + "y".repeat(1000)),
        },
      ],
      true,
    )
    const archive = join(config.profiles[0]!.home, "archived_sessions")
    mkdirSync(archive)
    writeFileSync(
      join(archive, "saved.jsonl"),
      JSON.stringify(record("needle archived")) + "\n{partial",
    )
    const result = await searchThreads(config, { query: "needle" }, env)
    // Newest message first; one with no time comes last
    expect(result.hits.map((h) => h.session)).toEqual(["two", "one", "saved"])
    expect(result.hits[0]!.path).toBe(compressed)
    expect(result.hits[0]!.excerpt).toMatch(/^…x+needley+…$/)
    expect(result.hits[0]!.excerpt.length).toBeLessThanOrEqual(500)
    expect(result.hits[1]).toMatchObject({
      cwd: "/repo",
      time: "2026-11-01T00:00:00Z",
      line: 3,
      excerpt: "prefix NEEDLE suffix",
    })
    const one = await searchThreads(config, { query: "needle", session: "one", role: "all" }, env)
    expect(one.hits.map((h) => h.role).toSorted()).toEqual(["assistant", "tool", "user"])
    const self = { ...env, CODEX_THREAD_ID: "one" }
    expect((await searchThreads(config, { query: "needle", session: "one" }, self)).hits).toEqual(
      [],
    )
    expect((await searchThreads(config, { query: "needle", limit: 1 }, env)).limit_reached).toBe(
      true,
    )
    expect(
      (await searchThreads(config, { query: "needle archived", limit: 1 }, env)).limit_reached,
    ).toBe(false)
    expect(result.failed).toEqual([])
  })
  test("a subagent rollout stays out under its parent's copied header", async () => {
    const { config, env } = setup()
    rollout(config, 0, "child", [
      { type: "session_meta", payload: { id: "child", source: { subagent: {} } } },
      { type: "session_meta", payload: { id: "parent", source: "cli" } },
      record("needle from the subagent"),
    ])
    expect((await searchThreads(config, { query: "needle" }, env)).hits).toEqual([])
  })
  test("a query after -- may start with a dash", async () => {
    const { config } = setup()
    // Every caller sees work profiles
    rollout(config, 1, "flags", [record("build w/ --bytecode")])
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      expect(await searchCommand(["--", "--bytecode", "--limit", "5"], config)).toBe(0)
      expect(JSON.parse(log.mock.calls[0]![0] as string).hits).toHaveLength(1)
    } finally {
      log.mockRestore()
    }
  })
  test("a usage mistake shows the help and exits 2", async () => {
    const { config } = setup()
    const err = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await searchCommand(["needle", "--bogus"], config)).toBe(2)
      expect(err.mock.calls[0]![0]).toBe("senu search: Unexpected argument --bogus")
    } finally {
      err.mockRestore()
    }
  })
  test("falls back to nearby whole words when no message holds the phrase", async () => {
    const { config, env } = setup()
    rollout(config, 0, "words", [
      { type: "session_meta", payload: { id: "words" } },
      record("so why is the search so slow?"),
      record("this research is slow, why"),
      record("why " + "x ".repeat(200) + "is search slow"),
      record('say "hello" twice'),
    ])
    const loose = await searchThreads(config, { query: "why is  search slow" }, env)
    expect(loose.match).toBe("words")
    expect(loose.hits.map((h) => h.excerpt)).toEqual(["so why is the search so slow?"])
    const whole = await searchThreads(config, { query: "is the search" }, env)
    expect([whole.match, whole.hits.length]).toEqual(["phrase", 1])
    expect((await searchThreads(config, { query: 'say "HELLO"' }, env)).hits).toHaveLength(1)
    rollout(config, 0, "wrapped", [record("then is\nthe  search done")])
    const wrapped = await searchThreads(config, { query: "is the search" }, env)
    expect([wrapped.match, wrapped.hits.length]).toEqual(["phrase", 2])
    expect((await searchThreads(config, { query: "absent words" }, env)).match).toBe("phrase")
  })
  test("one session returns its three newest hits unless it is asked for by id", async () => {
    const { config, env } = setup()
    rollout(config, 0, "chatty", [
      { type: "session_meta", payload: { id: "chatty" } },
      ...[1, 2, 3, 4, 5].map((n) =>
        Object.assign(record(`needle ${n}`), { timestamp: `2026-11-1${n}T00:00:00Z` }),
      ),
      { ...record("needle 5"), timestamp: "2026-11-15T00:00:00Z" },
    ])
    rollout(config, 0, "quiet", [
      { type: "session_meta", payload: { id: "quiet" } },
      record("needle"),
    ])
    const all = await searchThreads(config, { query: "needle" }, env)
    expect(all.hits.map((h) => h.session).toSorted()).toEqual([
      "chatty",
      "chatty",
      "chatty",
      "quiet",
    ])
    expect(all.limit_reached).toBe(false)
    expect(all.hits.filter((h) => h.session === "chatty").map((h) => h.excerpt)).toEqual([
      "needle 5",
      "needle 4",
      "needle 3",
    ])
    const one = await searchThreads(config, { query: "needle", session: "chatty", limit: 2 }, env)
    expect(one.hits.map((h) => h.excerpt)).toEqual(["needle 5", "needle 4"])
    const each = await searchThreads(config, { query: "needle", perSession: 1 }, env)
    expect(each.hits.map((h) => [h.session, h.excerpt])).toEqual([
      ["chatty", "needle 5"],
      ["quiet", "needle"],
    ])
  })
  test("plain sibling takes precedence and subagents and external symlinks stay out", async () => {
    const { config, env, root } = setup()
    rollout(config, 0, "same", [record("needle old")], true)
    rollout(config, 0, "same", [record("new contents")])
    rollout(config, 0, "sub", [
      { type: "session_meta", payload: { source: { subagent: {} } } },
      record("needle subagent"),
    ])
    const outside = join(root, "outside.jsonl")
    writeFileSync(outside, JSON.stringify(record("needle private")))
    mkdirSync(join(config.profiles[1]!.home, "sessions"))
    symlinkSync(outside, join(config.profiles[1]!.home, "sessions", "leak.jsonl"))
    expect((await searchThreads(config, { query: "needle" }, env)).hits).toEqual([])
  })
  test("thread titles match unless --messages, and --threads skips messages", async () => {
    const { config } = setup()
    const dir = join(config.profiles[2]!.home, "projects", "project")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "titled.jsonl"),
      [
        { type: "user", sessionId: "titled", cwd: "/repo", message: { content: "hello picker" } },
        { type: "ai-title", sessionId: "titled", aiTitle: "Fix the picker search" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    )
    const search = (query: string, only?: "threads" | "messages") =>
      searchThreads(config, { query, only }, {}).then((r) => r.hits.map((h) => [h.role, h.excerpt]))
    expect(await search("picker search")).toEqual([["title", "Fix the picker search"]])
    expect(await search("search picker")).toEqual([["title", "Fix the picker search"]])
    expect(await search("picker search", "messages")).toEqual([])
    // Found in its messages, the thread isn't listed again for its title
    expect(await search("picker")).toEqual([["user", "hello picker"]])
    expect(await search("picker", "threads")).toEqual([["title", "Fix the picker search"]])
  })
  test("Claude text and tools retain line citations, ignore sidechains and malformed records", async () => {
    const { config } = setup()
    const dir = join(config.profiles[2]!.home, "projects", "project")
    mkdirSync(dir, { recursive: true })
    const msg = (content: unknown, extra = {}) => ({
      type: "user",
      sessionId: "claude-one",
      cwd: "/repo",
      message: { role: "user", content },
      ...extra,
    })
    writeFileSync(
      join(dir, "claude-one.jsonl"),
      [
        "bad",
        JSON.stringify(msg("NEEDLE user")),
        JSON.stringify(msg("needle hidden", { isSidechain: true })),
        JSON.stringify(msg([{ type: "tool_result", content: "needle output" }])),
      ].join("\n"),
    )
    const result = await searchThreads(config, { query: "needle", role: "all" }, {})
    expect(result.hits.map((h) => [h.line, h.role, h.cwd])).toEqual([
      [2, "user", "/repo"],
      [4, "tool", "/repo"],
    ])
    expect(result.profiles).toEqual(["codex-work", "claude-work"])
  })
})
