import { afterEach, expect, test } from "bun:test"

import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

import type { UsageProfile } from "~/config.ts"
import { emptiesIn } from "~/usage/format.ts"
import { ProfileSection, type Section } from "~/usage/popup.tsx"
import type { RangeDays, RangeTotals, Today } from "~/usage/today.ts"
import { nowSeconds, type Limit, type Snapshot, type Spend } from "~/usage/types.ts"

const HOUR = 3600
const profile: UsageProfile = { kind: "claude", name: "personal", home: "/y" }

const range = (days: RangeDays): RangeTotals => ({
  days,
  tokens: 1_000_000 * days,
  cachedTokens: 0,
  uncachedTokens: 0,
  outputTokens: 0,
  costUsd: 2 * days,
  cacheSavingsUsd: 0,
  unpricedTokens: 0,
  sessions: days,
  models: [],
  buckets: Array.from({ length: days === 1 ? 24 : days }, (_, i) => ({
    label:
      days === 1 ? String(i).padStart(2, "0") : `2026-09-${String(22 + (i % 7)).padStart(2, "0")}`,
    tokens: 1000,
    costUsd: i === 3 ? 6 : 1,
  })),
})

const today: Today = {
  day: "2026-09-28",
  updatedAt: nowSeconds(),
  tokens: 0,
  cachedTokens: 0,
  costUsd: 2,
  unpricedTokens: 0,
  ranges: ([1, 7, 30] as const).map(range),
}

// Five-hour window, two hours in: 60% used runs dry in 1h20m; weekly 10% used lasts.
const fiveHour = (left: number): Limit => ({
  label: "5h",
  left,
  resetsAt: nowSeconds() + 3 * HOUR,
  windowMs: 5 * HOUR * 1000,
})
const weekly: Limit = {
  label: "weekly",
  left: 90,
  resetsAt: nowSeconds() + 6 * 24 * HOUR,
  windowMs: 7 * 24 * HOUR * 1000,
}

const snapshot = (limits: Limit[], spend: Spend | null = null): Snapshot => ({
  ok: true,
  error: null,
  updatedAt: nowSeconds(),
  planType: null,
  limits,
  spend,
  banked: null,
})

let destroy: (() => void) | null = null
afterEach(() => destroy?.())

async function frame(
  looked: boolean,
  limits: Limit[] = [fiveHour(40), weekly],
  width = 96,
  collapsed = false,
  todayOf: Today = today,
  spend: Spend | null = null,
): Promise<string> {
  const section: Section = {
    snapshot: snapshot(limits, spend),
    refreshing: false,
    justUpdated: false,
    loadedAt: 0,
    landedAt: null,
  }
  const t = await testRender(
    <ProfileSection
      profile={profile}
      section={section}
      dots="..."
      fillFrom={null}
      right={width - 1}
      looked={looked}
      collapsed={collapsed}
      today={todayOf}
      days={7}
      scanning={false}
    />,
    { width, height: 14 },
  )
  destroy = () => act(() => t.renderer.destroy())
  await act(() => t.renderOnce())
  return t.captureCharFrame()
}

test("emptiesIn projects the burn rate so far", () => {
  expect(emptiesIn(40, nowSeconds() + 3 * HOUR, 5 * HOUR * 1000)).toBeCloseTo((4 * HOUR) / 3, -1)
  expect(emptiesIn(100, nowSeconds() + 3 * HOUR, 5 * HOUR * 1000)).toBe(Infinity)
  expect(emptiesIn(40, nowSeconds() + 3 * HOUR, null)).toBeNull()
  // Ten minutes into five hours is too early to project.
  expect(emptiesIn(40, nowSeconds() + 5 * HOUR - 600, 5 * HOUR * 1000)).toBeNull()
})

test("a profile senu looks at opens a chart of its cost", async () => {
  const f = await frame(true)
  expect(f).toContain("▸")
  expect(f).toContain("today  7d  30d")
  expect(f).toMatch(/5h dry in ~1h20m · \d\d:\d\d/)
  expect(f).toContain("avg $2.00/day · peak $6.00 Fri 25")
  expect(f).toMatch(/Tu\s+We\s+Th\s+Fr\s+Sa\s+Su\s+Mo\s*$/m)
  expect(f).toMatch(/today {2}7d {2}30d ─+ \$14\.00 at API rates/)
  expect(f).toMatch(/██ +5h dry in ~1h20m/)
})

test("the pace line names an empty limit and never guesses green", async () => {
  expect(await frame(true, [fiveHour(0), weekly])).toMatch(/5h empty · back in 3h/)
  // Both empty: the weekly lockout outlasts the session's.
  expect(await frame(true, [fiveHour(0), { ...weekly, left: 0 }])).toMatch(
    /weekly empty · back in 6d/,
  )
  expect(await frame(true, [fiveHour(100), weekly])).toContain("holds to reset")
  expect(await frame(true, [{ ...fiveHour(40), windowMs: null }, weekly])).toContain(
    "5h pace unknown",
  )
  const fresh = { ...weekly, resetsAt: nowSeconds() + 7 * 24 * HOUR - 600 }
  expect(await frame(true, [fiveHour(100), fresh])).toContain(
    "holds so far · weekly too new to read",
  )
  // A reset the cached snapshot predates means the window is fresh again.
  const reset = { ...fiveHour(40), resetsAt: nowSeconds() - 60 }
  expect(await frame(true, [reset, weekly])).toContain("holds to reset")
})

test("a narrow glance stacks its stats under the chart, indented off the axis", async () => {
  const f = await frame(true, undefined, 64)
  const lines = f.split("\n")
  const axis = lines.findIndex((l) => /Tu\s+We/.test(l))
  expect(lines[axis + 1]).toMatch(/^ {13}5h dry in ~1h20m/)
})

test("profiles senu isn't looking at stay closed", async () => {
  const f = await frame(false)
  expect(f).not.toContain("▸")
  expect(f).not.toContain("API rates")
})

test("a folded title shows the profile's lowest limit where freshness was", async () => {
  const f = await frame(false, undefined, 96, true)
  expect(f).toMatch(/Claude · personal\s+5h 40%/)
  expect(f).not.toContain("updated")
  expect(f).not.toContain("weekly")
})

test("a cached window past its reset reads as refilled, not empty", async () => {
  const stale = { ...fiveHour(0), resetsAt: nowSeconds() - 60 }
  expect(await frame(true, [stale, weekly])).not.toContain("empty")
  expect(await frame(false, [stale, weekly], 96, true)).toMatch(/weekly 90%/)
})

test("a folded profile with no readable limits says so", async () => {
  const unread = { ...fiveHour(40), left: null }
  expect(await frame(false, [unread], 96, true)).toContain("limits n/a")
})

test("usage the price table can't cost is charted in tokens, not called empty", async () => {
  const unpriced: Today = {
    ...today,
    ranges: ([1, 7, 30] as const).map((d) => {
      const r = range(d)
      for (const b of r.buckets) b.costUsd = 0
      return Object.assign(r, { costUsd: 0, unpricedTokens: r.tokens })
    }),
  }
  const f = await frame(true, undefined, 96, false, unpriced)
  expect(f).not.toContain("no usage")
  expect(f).toContain("7M tok unpriced")
  expect(f).toMatch(/avg 1M tok\/day · peak 1k tok/)
})

test("the average line sheds the peak's date, then the peak, before it overflows", async () => {
  expect(await frame(true, undefined, 74)).toMatch(/avg \$2\.00\/day · peak \$6\.00\s*$/m)
  expect(await frame(true, undefined, 36)).toMatch(/avg \$2\.00\/day\s*$/m)
})

test("a long pace tail shortens rather than running past the stats", async () => {
  const fresh = { ...weekly, resetsAt: nowSeconds() + 7 * 24 * HOUR - 600 }
  const f = await frame(true, [fiveHour(100), fresh], 74)
  expect(f).toContain("holds so far · weekly too new")
  expect(f).not.toContain("to read")
})

test("an empty range drops the strip's rule along with the total", async () => {
  const none: Today = { ...today, ranges: [] }
  const f = await frame(true, undefined, 96, false, none)
  expect(f).toContain("no transcripts")
  expect(f).not.toContain("──")
})

test("a reached spend cap doesn't read as a lockout while plan limits have room", async () => {
  const cap: Spend = {
    used: 250.71,
    limit: 250,
    left: 0,
    resetsAt: nowSeconds() + 20 * 24 * HOUR,
    reached: true,
  }
  const looked = await frame(true, [fiveHour(40), weekly], 96, false, today, cap)
  expect(looked).not.toContain("Spend empty")
  expect(looked).toMatch(/5h dry in ~1h20m/)
  const folded = await frame(false, [fiveHour(40), weekly], 96, true, today, cap)
  expect(folded).not.toContain("Spend 0%")
  // With no plan limits, the cap is all there is.
  expect(await frame(true, [], 96, false, today, cap)).toContain("Spend empty")
})
