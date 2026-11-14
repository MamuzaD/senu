import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { readCommand } from "~/search/read-command.ts"
import { readThread, renderThread } from "~/search/read.ts"

import { cleanup, record, rollout, setup } from "./chats.ts"

afterEach(cleanup)

const ID = "01a1d3a4-0000-7000-8000-000000000000"
const meta = { type: "session_meta", payload: { id: ID, source: "cli", cwd: "/repo" } }
const tool = (output: string) => ({
  type: "response_item",
  payload: { type: "function_call_output", output },
})

describe("senu read", () => {
  test("finds a rollout by the id ending its name, joins a role's entries, and skips tools unless asked", () => {
    const { config, env } = setup()
    const path = rollout(
      config,
      0,
      `rollout-2026-11-13T01-49-13-${ID}`,
      [
        meta,
        record("fix pagination"),
        tool("ls output"),
        record("looking", "assistant"),
        record("done", "assistant"),
      ],
      true,
    )
    const thread = readThread(config, { session: ID }, env)
    expect(thread).toMatchObject({ profile: "codex-personal", cwd: "/repo", path, total: 2 })
    expect(thread.turns.map((t) => [t.role, t.line, t.text])).toEqual([
      ["user", 2, "fix pagination"],
      ["assistant", 4, "looking\n\ndone"],
    ])
    // A tail of the id, even at a dash, names nothing
    for (const session of ["000000000000", "8000-000000000000", `13-${ID}`])
      expect(() => readThread(config, { session }, env)).toThrow("No saved thread")
    const tools = readThread(config, { session: ID, tools: true }, env)
    expect(tools.turns.map((t) => t.role)).toEqual(["user", "tool", "assistant"])
  })
  test("a budget keeps the first prompt and the newest unbroken run, whole, and marks the gaps", () => {
    const { config, env } = setup()
    rollout(config, 0, ID, [
      meta,
      record("goal"),
      ...Array.from({ length: 20 }, (_, n) =>
        record(`turn ${n} ${"x".repeat(200)}`, ["assistant", "user"][n % 2]),
      ),
      record("y".repeat(5000), "assistant"),
      record("latest ask"),
    ])
    const thread = readThread(config, { session: ID, maxChars: 2000 }, env)
    const [first, ...rest] = thread.turns
    const last = rest.pop()!
    expect([first!.text, last.text]).toEqual(["goal", "latest ask"])
    // The 5000-character reply is skipped, not cut, and older turns fill the room behind it
    expect(rest.map((t) => t.index)).toEqual([16, 17, 18, 19, 20])
    expect([thread.total, thread.omitted]).toEqual([23, 16])
    const text = renderThread(thread)
    expect(text).toContain("Kept 7 of 23 turns intact; omitted 16.")
    expect(text).toContain(`--session ${ID} --role all`)
    expect(text).toContain("]\ngoal\n\n[… 15 turns omitted …]\n\n[user · line 18]\nturn 15")
    expect(text).toMatch(/\[… 1 turn omitted …\]\n\n\[user · line 24\]\nlatest ask\n$/)
    expect(text.length).toBeLessThanOrEqual(2000)
  })
  test("output stays within any budget past the header, even when the last turn is omitted", () => {
    const { config, env } = setup()
    rollout(config, 0, ID, [
      meta,
      record("u".repeat(5000)),
      record("a".repeat(300), "assistant"),
      record("v".repeat(5000)),
    ])
    for (let maxChars = 700; maxChars < 1200; maxChars++)
      expect(
        renderThread(readThread(config, { session: ID, maxChars }, env)).length,
      ).toBeLessThanOrEqual(maxChars)
    expect(() => readThread(config, { session: ID, maxChars: 50 }, env)).toThrow("header")
  })
  test("reads Claude threads by file name and stays within the caller's profiles", () => {
    const { config, env } = setup()
    const dir = join(config.profiles[2]!.home, "projects", "project")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "claude-one.jsonl"),
      JSON.stringify({
        type: "user",
        sessionId: "claude-one",
        cwd: "/w",
        message: { content: "hi" },
      }),
    )
    expect(readThread(config, { session: "claude-one" }, env).turns[0]!.text).toBe("hi")
    rollout(config, 0, "personal-one", [record("private")])
    const work = { CLAUDE_CONFIG_DIR: config.profiles[2]!.home }
    expect(() => readThread(config, { session: "personal-one" }, work)).toThrow(
      "No saved thread personal-one in codex-work, claude-work",
    )
  })
  test("focuses on a search line, including entries joined into a turn", () => {
    const { config, env } = setup()
    rollout(config, 0, ID, [
      meta,
      record("first"),
      record("reply", "assistant"),
      record("continued", "assistant"),
      record("target"),
      record("answer", "assistant"),
      record("last"),
    ])
    const read = (extra = {}) => readThread(config, { session: ID, line: 4, ...extra }, env)
    expect(read({ before: 0, after: 0 }).turns.map((t) => t.text)).toEqual(["reply\n\ncontinued"])
    expect(read({ before: 1, after: 1 }).turns.map((t) => t.index)).toEqual([0, 1, 2])
    expect(renderThread(read({ before: 0, after: 0 }))).toContain(`--line 4 -C N`)
    expect(renderThread(read({ before: 0, after: 0 }))).toContain("increase --max-chars")
    expect(read({ after: 1 }).turns.map((t) => t.index)).toEqual([1, 2])
    expect(read({ before: 1 }).turns.map((t) => t.index)).toEqual([0, 1])
    expect(read().turns.map((t) => t.index)).toEqual([0, 1, 2, 3, 4])
    expect(read({ line: 7, before: 0, after: 3 }).turns.map((t) => t.index)).toEqual([4])
    for (const extra of [
      { line: 1 },
      { line: 100 },
      { line: 0 },
      { before: -1 },
      { after: 1.5 },
      { line: undefined, before: 1 },
    ])
      expect(() => read(extra)).toThrow()
  })
  test("keeps the target within budget and requires tools for a tool hit", () => {
    const { config, env } = setup()
    rollout(config, 0, ID, [
      meta,
      record("goal"),
      tool("tool output"),
      record("x".repeat(5000), "assistant"),
      record("last"),
    ])
    expect(() => readThread(config, { session: ID, line: 3 }, env)).toThrow("--tools")
    expect(
      readThread(config, { session: ID, line: 3, tools: true, before: 0, after: 0 }, env).turns[0]!
        .text,
    ).toBe("tool output")
    expect(() => readThread(config, { session: ID, line: 4, maxChars: 1000 }, env)).toThrow(
      "Target turn exceeds",
    )
    const thread = readThread(config, { session: ID, line: 5, maxChars: 1000 }, env)
    expect(thread.turns.some((t) => t.text === "last")).toBe(true)
    expect(renderThread(thread).length).toBeLessThanOrEqual(1000)
  })
  test("long context flags match shorthand and preserve flag order", async () => {
    const { config } = setup()
    rollout(config, 1, ID, [
      meta,
      record("first"),
      record("reply", "assistant"),
      record("target"),
      record("answer", "assistant"),
      record("last"),
    ])
    const out = spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      for (const [flag, expected] of [
        ["--before-context", [0, 1, 2]],
        ["--after-context", [2, 3, 4]],
        ["--context", [0, 1, 2, 3, 4]],
      ] as const) {
        out.mockClear()
        expect(await readCommand([ID, "--line", "4", flag, "2", "--json"], config)).toBe(0)
        expect(
          JSON.parse(out.mock.calls[0]![0] as string).turns.map((t: { index: number }) => t.index),
        ).toEqual(expected)
      }
      out.mockClear()
      expect(
        await readCommand(
          [ID, "--line", "4", "--context", "2", "-B", "0", "--after-context", "1", "--json"],
          config,
        ),
      ).toBe(0)
      expect(
        JSON.parse(out.mock.calls[0]![0] as string).turns.map((t: { index: number }) => t.index),
      ).toEqual([2, 3])
    } finally {
      out.mockRestore()
    }
  })
  test("prints JSON, and a usage mistake shows the help and exits 2", async () => {
    const { config } = setup()
    rollout(config, 1, ID, [meta, record("work ask")])
    const out = spyOn(process.stdout, "write").mockImplementation(() => true)
    const err = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await readCommand([ID, "--json"], config)).toBe(0)
      expect(JSON.parse(out.mock.calls[0]![0] as string).turns[0].text).toBe("work ask")
      out.mockClear()
      expect(
        await readCommand([ID, "--line", "2", "-C", "0", "-B", "1", "-A", "2", "--json"], config),
      ).toBe(0)
      expect(JSON.parse(out.mock.calls[0]![0] as string).turns[0].text).toBe("work ask")
      for (const flags of [["--line"], ["-C", "1"], ["--line", "0"], ["--line", "2", "-A", "-1"]])
        expect(await readCommand([ID, ...flags], config)).toBe(2)
      expect(await readCommand([ID, "--max-chars", "0"], config)).toBe(2)
      expect(await readCommand(["missing"], config)).toBe(1)
      expect(err.mock.calls.at(-1)![0]).toStartWith("senu read: No saved thread missing")
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
  })
})
