import { expect, test } from "bun:test"

import { ARCHIVE_AFTER_MS, sections, toolSummary } from "~/threads/browse/browser.tsx"

test("tool summaries read by kind, in a fixed order, singular when one", () => {
  expect(toolSummary({ run: 4, read: 1, other: 2 })).toBe(
    "read 1 file · ran 4 commands · 2 other tools",
  )
  expect(toolSummary({ edit: 2, search: 1, web: 3, agent: 1 })).toBe(
    "changed 2 files · searched 1 time · fetched 3 pages · 1 agent call",
  )
})

test("sections: running, then the last 3 days, then archived; running never archives", () => {
  const now = 10 * ARCHIVE_AFTER_MS
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
      entry("old but running", 2 * ARCHIVE_AFTER_MS, true),
      entry("today", 1000),
      entry("last week", 2 * ARCHIVE_AFTER_MS),
    ],
    now,
  ).map((s) => [s.label, s.entries.map((e) => e.title)])
  expect(got).toEqual([
    ["running", ["old but running"]],
    ["recent", ["today"]],
    ["archived", ["last week"]],
  ])
})
