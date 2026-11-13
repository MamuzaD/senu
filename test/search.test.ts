import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { loadConfig } from "~/config.ts"
import { allowedProfiles } from "~/privacy.ts"
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
  test("canonical Codex messages, compressed and archived files, roles, exclusions and bounded excerpts", () => {
    const { config, env } = setup()
    rollout(config, 0, "plain", [
      { type: "session_meta", payload: { id: "one", source: "cli" } },
      { type: "event_msg", payload: { type: "user_message", message: "needle duplicate" } },
      record("prefix NEEDLE suffix"),
      record("needle assistant", "assistant"),
      { type: "response_item", payload: { type: "function_call_output", output: "needle tool" } },
    ])
    const compressed = rollout(
      config,
      0,
      "compressed",
      [
        { type: "session_meta", payload: { id: "two" } },
        record("x".repeat(1000) + "needle" + "y".repeat(1000)),
      ],
      true,
    )
    const archive = join(config.profiles[0]!.home, "archived_sessions")
    mkdirSync(archive)
    writeFileSync(
      join(archive, "saved.jsonl"),
      JSON.stringify(record("needle archived")) + "\n{partial",
    )
    const result = searchThreads(config, { query: "needle" }, env)
    expect(result.hits).toHaveLength(3)
    expect(result.hits.at(-1)?.path).toBe(compressed)
    expect(result.hits.at(-1)!.excerpt.length).toBeLessThanOrEqual(500)
    expect(
      searchThreads(config, { query: "needle", session: "one", role: "all" }, env).hits.map(
        (h) => h.role,
      ),
    ).toEqual(["user", "assistant", "tool"])
    expect(
      searchThreads(config, { query: "needle", session: "one" }, { ...env, CODEX_THREAD_ID: "one" })
        .hits,
    ).toEqual([])
    expect(searchThreads(config, { query: "needle", limit: 1 }, env).limit_reached).toBe(true)
    expect(searchThreads(config, { query: "needle archived", limit: 1 }, env).limit_reached).toBe(
      false,
    )
    expect(result.failed).toEqual([])
  })
  test("plain sibling takes precedence and subagents and external symlinks stay out", () => {
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
    expect(searchThreads(config, { query: "needle" }, env).hits).toEqual([])
  })
  test("Claude text and tools retain line citations, ignore sidechains and malformed records", () => {
    const { config } = setup()
    const dir = join(config.profiles[2]!.home, "projects", "project")
    mkdirSync(dir, { recursive: true })
    const msg = (content: unknown, extra = {}) => ({
      type: "user",
      sessionId: "claude-one",
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
    const result = searchThreads(config, { query: "needle", role: "all" }, {})
    expect(result.hits.map((h) => [h.line, h.role])).toEqual([
      [2, "user"],
      [4, "tool"],
    ])
    expect(result.profiles).toEqual(["codex-work", "claude-work"])
  })
})
