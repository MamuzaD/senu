import { expect, test } from "bun:test"

import { toolSummary } from "~/threads/browse/browser.tsx"

test("tool summaries read by kind, in a fixed order, singular when one", () => {
  expect(toolSummary({ run: 4, read: 1, other: 2 })).toBe(
    "read 1 file · ran 4 commands · 2 other tools",
  )
  expect(toolSummary({ edit: 2, search: 1, web: 3, agent: 1 })).toBe(
    "changed 2 files · searched 1 time · fetched 3 pages · 1 agent call",
  )
})
