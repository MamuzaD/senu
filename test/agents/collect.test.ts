import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  HEARTBEAT_STALE_SECONDS,
  attentionOf,
  codexTask,
  daemonFrom,
  foldWindows,
  liveAttention,
  sortRows,
  titleTask,
  trustsState,
  type AgentRow,
  type Attention,
} from "~/agents/collect.ts"

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../fixtures/detect", name), "utf8")

function row(
  windowId: string,
  state: Attention,
  activity: number,
  extra: Partial<AgentRow & { active: boolean }> = {},
) {
  return {
    windowId,
    session: "s",
    windowIndex: 1,
    windowName: "w",
    paneId: `%${windowId}`,
    agent: "claude" as const,
    state,
    activity,
    label: windowId,
    source: "watch" as const,
    active: false,
    ...extra,
  }
}

describe("sortRows", () => {
  test("blocked > working > done > idle, ties by recency", () => {
    const rows = [
      row("a", "idle", 50),
      row("b", "done", 10),
      row("c", "working", 5),
      row("d", "blocked", 1),
      row("e", "working", 30),
      row("f", "idle", 90),
    ]
    expect(sortRows(rows).map((r) => r.windowId)).toEqual(["d", "e", "c", "b", "f", "a"])
  })
})

describe("foldWindows", () => {
  test("one row per window, the neediest pane standing for it, with the newest activity", () => {
    const rows = foldWindows([
      row("w1", "idle", 100, { paneId: "%1" }),
      row("w1", "blocked", 20, { paneId: "%2" }),
      row("w2", "working", 50, { paneId: "%3" }),
    ])
    expect(rows.map((r) => [r.windowId, r.paneId, r.state, r.activity])).toEqual([
      ["w1", "%2", "blocked", 100],
      ["w2", "%3", "working", 50],
    ])
  })

  test("a tie goes to the active pane", () => {
    const rows = foldWindows([
      row("w", "idle", 1, { paneId: "%1" }),
      row("w", "idle", 1, { paneId: "%2", active: true }),
    ])
    expect(rows[0]!.paneId).toBe("%2")
    expect("active" in rows[0]!).toBe(false)
  })
})

describe("states", () => {
  test("@ai_state values", () => {
    expect(attentionOf("done")).toBe("done")
    expect(attentionOf("blocked")).toBe("blocked")
    expect(attentionOf("")).toBeNull()
    expect(attentionOf("bogus")).toBeNull()
  })

  test("codex's unknown is idle", () => {
    expect(liveAttention("unknown")).toBe("idle")
    expect(liveAttention("working")).toBe("working")
  })
})

describe("daemon or live", () => {
  const now = 1_000_000
  test("the heartbeat", () => {
    expect(daemonFrom("", now)).toBe("unknown")
    expect(daemonFrom("garbage", now)).toBe("unknown")
    expect(daemonFrom(String(now - 2), now)).toBe("alive")
    expect(daemonFrom(String(now - HEARTBEAT_STALE_SECONDS - 1), now)).toBe("dead")
  })

  test("@ai_state is trusted unless the daemon is known dead", () => {
    expect(trustsState("working", "alive")).toBe(true)
    expect(trustsState("working", "unknown")).toBe(true)
    expect(trustsState("working", "dead")).toBe(false)
    expect(trustsState("", "alive")).toBe(false)
    expect(trustsState("", "unknown")).toBe(false)
  })
})

describe("codexTask", () => {
  test("the last prompt an agent turn followed, not the input box", () => {
    expect(codexTask(fixture("live-codex-idle.screen"))).toBe("is the sample command ready")
    expect(codexTask(fixture("live-codex-idle-draft.screen"))).toBe("check the sample project")
    expect(codexTask(fixture("codex-working-screen.screen"))).toBe("update the sample status line")
  })

  test("nothing to read", () => {
    expect(codexTask("")).toBeNull()
    expect(codexTask("› Ask Codex to do anything\n\n  gpt · Context 97% left")).toBeNull()
  })
})

describe("titleTask", () => {
  test("claude: the task after its glyph or spinner", () => {
    expect(titleTask("✳ Port detection engine", "claude", "senu")).toBe("Port detection engine")
    expect(titleTask("⠂ Port detection engine", "claude", "senu")).toBe("Port detection engine")
    expect(titleTask("✳ Claude Code", "claude", "senu")).toBeNull()
    expect(titleTask("", "claude", "senu")).toBeNull()
  })

  test("codex: `<task> | <dir>`, and nothing from a bare dir or a blocker", () => {
    expect(titleTask("⠋ Update tmux popup binary | dotfiles", "codex", "x")).toBe(
      "Update tmux popup binary",
    )
    expect(titleTask("preparation", "codex", "x")).toBeNull()
    expect(titleTask("Action Required | dotfiles", "codex", "x")).toBeNull()
  })
})
