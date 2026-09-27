import { afterEach, expect, test } from "bun:test"

import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import type { UsageProfile } from "~/config.ts"
import { CostView, type Breakdown } from "~/usage/popup.tsx"
import type { Bucket, RangeDays, RangeTotals, Today } from "~/usage/today.ts"

const profiles: UsageProfile[] = [
  { kind: "codex", name: "work", home: "/x" },
  { kind: "claude", name: "personal", home: "/y" },
  { kind: "claude", name: "idle", home: "/z" },
]

const buckets = (days: RangeDays, cost: number): Bucket[] =>
  Array.from({ length: days === 1 ? 24 : days }, (_, i) => ({
    label: days === 1 ? String(i).padStart(2, "0") : `2026-09-${String(i + 1).padStart(2, "0")}`,
    tokens: 1000,
    costUsd: cost,
  }))

const range = (days: RangeDays, cost: number, model: string): RangeTotals => ({
  days,
  tokens: 1_000_000 * days,
  cachedTokens: 800_000 * days,
  uncachedTokens: 150_000 * days,
  outputTokens: 50_000 * days,
  costUsd: cost * days,
  cacheSavingsUsd: cost * days * 3,
  unpricedTokens: 0,
  sessions: days,
  models: [{ model, tokens: 1_000_000 * days, cachedTokens: 800_000 * days, costUsd: cost * days }],
  buckets: buckets(days, cost),
})

const today = (cost: number, model: string): Today => ({
  day: "2026-09-26",
  updatedAt: Math.floor(Date.now() / 1000),
  tokens: 0,
  cachedTokens: 0,
  costUsd: cost,
  unpricedTokens: 0,
  ranges: ([1, 7, 30] as const).map((d) => range(d, cost, model)),
})

const idle: Today = {
  ...today(0, "none"),
  ranges: ([1, 7, 30] as const).map((d) =>
    Object.assign(range(d, 0, "none"), { tokens: 0, models: [], sessions: 0 }),
  ),
}

let destroy: (() => void) | null = null
afterEach(() => destroy?.())

async function frame(days: RangeDays, breakdown: Breakdown = "profile"): Promise<string> {
  const t = await testRender(
    <CostView
      profiles={profiles}
      todays={[today(10, "gpt-test"), today(30, "claude-test-20260101"), idle]}
      watching={[false, false, false]}
      days={days}
      breakdown={breakdown}
      dots="..."
      right={95}
      rows={24}
    />,
    { width: 96, height: 24 },
  )
  destroy = () => act(() => t.renderer.destroy())
  await act(() => t.renderOnce())
  return t.captureCharFrame()
}

test("the 7-day view totals every profile", async () => {
  const f = await frame(7)
  expect(f).toContain("today  7d  30d")
  expect(f).toContain("$280.00  API estimate · 14 sessions · 14M tok")
  expect(f).toContain("daily cost")
  expect(f).toContain("by profile  by model")
  expect(f).toMatch(/Codex · work\s+\$70\.00\s+25%\s+7M tok/)
  expect(f).toMatch(/Claude · personal\s+\$210\.00\s+75%\s+7M tok/)
  expect(f).not.toContain("gpt-test")
  expect(f).not.toContain("idle")
  expect(f).toContain("cached 17M · uncached 3.1M · output 1.1M · cache saved $840.00")
})

test("by model ranks models and tags the profiles that used them", async () => {
  const f = await frame(7, "model")
  expect(f).toMatch(/claude-test\s+personal\s+\$210\.00\s+75%\s+7M tok/)
  expect(f).toMatch(/gpt-test\s+work\s+\$70\.00\s+25%\s+7M tok/)
  expect(f.indexOf("claude-test")).toBeLessThan(f.indexOf("gpt-test"))
  expect(f).not.toContain("Codex · work")
})

test("each range labels as many bars as fit", async () => {
  expect(await frame(7)).toMatch(/Tue 1\s+Wed 2\s+Thu 3\s+Fri 4\s+Sat 5\s+Sun 6\s+Mon 7/)
  expect(await frame(1)).toMatch(/00h\s+03h\s+06h/)
  expect(await frame(30)).toMatch(/Sep 7\s+Sep 14\s+Sep 21\s+Sep 30\s*\n/)
})
