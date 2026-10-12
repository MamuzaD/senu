import { expect, test } from "bun:test"

import { matches, sections, toolSummary } from "~/threads/browse/browser.tsx"
import type { Thread } from "~/threads/thread.ts"

const RECENT_MS = 3 * 24 * 60 * 60 * 1000

test("tool summaries read by kind, in a fixed order, singular when one", () => {
  expect(toolSummary({ run: 4, read: 1, other: 2 })).toBe(
    "read 1 file · ran 4 commands · 2 other tools",
  )
  expect(toolSummary({ edit: 2, search: 1, web: 3, agent: 1 })).toBe(
    "changed 2 files · searched 1 time · fetched 3 pages · 1 agent call",
  )
})

test("sections: running, then the last 3 days, then older; running never ages", () => {
  const now = 10 * RECENT_MS
  const entry = (title: string, ageMs: number, live = false) => ({
    thread: null,
    agent: "claude" as const,
    title,
    cwd: "/p",
    updatedMs: now - ageMs,
    live: live
      ? { state: "idle" as const, paneId: "%1", windowId: "@1", windowIndex: 1, session: "s" }
      : null,
  })
  const got = sections(
    [
      entry("old but running", 2 * RECENT_MS, true),
      entry("today", 1000),
      entry("last week", 2 * RECENT_MS),
    ],
    RECENT_MS,
    now,
  ).map((s) => [s.label, s.entries.map((e) => e.title)])
  expect(got).toEqual([
    ["running", ["old but running"]],
    ["recent", ["today"]],
    ["older", ["last week"]],
  ])
})

test("search matches the tmux session and the session id too", () => {
  const e = {
    thread: { sessionId: "019a-abc", profile: "codex-work" } as Thread,
    agent: "codex" as const,
    title: "fix the build",
    cwd: "/p/senu",
    updatedMs: 0,
    live: { state: "idle" as const, paneId: "%1", windowId: "@1", windowIndex: 1, session: "api" },
  }
  expect(matches(e, "api")).toBe(true)
  expect(matches(e, "019a")).toBe(true)
  expect(matches(e, "build senu")).toBe(true)
  expect(matches(e, "web")).toBe(false)
})
