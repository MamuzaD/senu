import { describe, expect, test } from "bun:test"

import {
  floating,
  paneId,
  rexRow,
  rexRunArgs,
  terminalsIn,
  type RexAgent,
} from "~/threads/live/rex.ts"

const shell = "com.superlogical.terminal.shell"

const view = {
  session_id: "session:a",
  label: "work",
  windows: [
    {
      window_id: "window:1",
      focused_block_id: "block:2",
      layers: [{ kind: "tiled", blocks: [{ block_id: "block:1", flavor: shell }] }],
    },
    {
      window_id: "window:2",
      focused_block_id: "block:2",
      layers: [
        { kind: "tiled", blocks: [{ block_id: "block:2", flavor: shell }] },
        { kind: "floating", blocks: [{ block_id: "block:3", flavor: shell }] },
        { kind: "tiled", blocks: [{ block_id: "block:4", flavor: "com.example.web" }] },
      ],
    },
  ],
}

const agent = (over: Partial<RexAgent> = {}): RexAgent => ({
  id: "session:a/block:1",
  pid: 10,
  agent: "codex",
  session: "work",
  windowId: "window:1",
  windowIndex: 1,
  active: true,
  cwd: "/code/senu",
  title: "",
  record: null,
  ...over,
})

describe("terminalsIn", () => {
  test("lists terminals in every layer, numbering tabs from 1", () => {
    const found = terminalsIn(view)
    expect(found.map((t) => t.blockId)).toEqual(["block:1", "block:2", "block:3"])
    expect(found.map((t) => t.windowIndex)).toEqual([1, 2, 2])
    expect(found[1]).toMatchObject({ id: "session:a/block:2", session: "work", active: true })
    expect(found[0]!.active).toBe(false)
  })
})

describe("floating", () => {
  test("is true only for a block in a floating layer", () => {
    expect(floating(view, "block:3")).toBe(true)
    expect(floating(view, "block:2")).toBe(false)
  })
})

describe("rexRow", () => {
  test("takes the state, time, and label from the record", () => {
    const row = rexRow(
      agent({
        record: { state: "blocked", msg: "answer: stop?", updated_at: "2026-11-01T21:00:00Z" },
      }),
    )
    expect(row).toMatchObject({
      state: "blocked",
      label: "answer: stop?",
      activity: Date.parse("2026-11-01T21:00:00Z") / 1000,
      source: "watch",
      paneId: "session:a/block:1",
    })
  })

  test("shows an error as done", () => {
    expect(rexRow(agent({ record: { state: "error" } })).state).toBe("done")
  })

  test("is idle with no record", () => {
    expect(rexRow(agent())).toMatchObject({ state: "idle", activity: 0 })
  })

  test("falls back to the title's task, then the directory", () => {
    expect(rexRow(agent({ title: "Fix login | senu" })).label).toBe("Fix login")
    expect(rexRow(agent({ title: "senu" })).label).toBe("senu")
  })
})

describe("rexRunArgs", () => {
  test("passes env through env, which rex run has no flag for", () => {
    const launch = { argv: ["codex", "resume", "t"], cwd: "/c", env: { CODEX_HOME: "/h" } }
    expect(rexRunArgs(launch, "session:a")).toEqual([
      "run",
      "-s",
      "session:a",
      "-c",
      "/c",
      "--",
      "env",
      "CODEX_HOME=/h",
      "codex",
      "resume",
      "t",
    ])
  })

  test("leaves a launch with no env alone", () => {
    const args = rexRunArgs({ argv: ["claude"], cwd: "/c", env: {} }, "s")
    expect(args.slice(-2)).toEqual(["--", "claude"])
  })
})

test("paneId carries the session", () => {
  expect(paneId("session:a", "block:1")).toBe("session:a/block:1")
})
