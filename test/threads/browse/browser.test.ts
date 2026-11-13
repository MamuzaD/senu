import { expect, test } from "bun:test"

import { highlights, matches, sections, toolSummary } from "~/threads/browse/browser.tsx"
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
    [],
    now,
  ).map((s) => [s.label, s.entries.map((e) => e.title)])
  expect(got).toEqual([
    ["running", ["old but running"]],
    ["recent", ["today"]],
    ["older", ["last week"]],
  ])
})

test("sections: pinned threads lead in pin order and leave the other sections", () => {
  const now = 10 * RECENT_MS
  const entry = (sessionId: string, ageMs: number, live = false) => ({
    thread: { sessionId, profile: "claude" } as Thread,
    agent: "claude" as const,
    title: sessionId,
    cwd: "/p",
    updatedMs: now - ageMs,
    live: live
      ? { state: "working" as const, paneId: "%1", windowId: "@1", windowIndex: 1, session: "s" }
      : null,
  })
  const got = sections(
    [entry("running", 0, true), entry("today", 1000), entry("old", 2 * RECENT_MS)],
    RECENT_MS,
    ["claude:old", "claude:gone", "claude:running"],
    now,
  ).map((s) => [s.label, s.entries.map((e) => e.title)])
  expect(got).toEqual([
    ["pinned", ["old", "running"]],
    ["recent", ["today"]],
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

test("highlights the whole phrase, else each word", () => {
  expect(highlights("Why is Search slow? search again", "search")).toEqual([
    [7, 13],
    [20, 26],
  ])
  expect(highlights("so why is the search slow", "is the  search")).toEqual([[7, 20]])
  expect(highlights("search is slow", "slow search")).toEqual([
    [10, 14],
    [0, 6],
  ])
  expect(highlights("this is a bug in data", "is a bug!")).toEqual([
    [5, 7],
    [8, 9],
  ])
  expect(highlights("anything", " ")).toEqual([])
})
