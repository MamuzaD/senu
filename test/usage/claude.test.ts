import { expect, test } from "bun:test"

import { parseUsage } from "~/usage/claude.ts"

const window = (utilization: number) => ({ utilization, resets_at: "2026-11-19T02:00:00+00:00" })
const rows = (data: unknown) => parseUsage(data).limits.map((l) => [l.label, l.left])

test("shows a model's weekly limit under the name the server gives it", () => {
  const data = {
    five_hour: window(68),
    seven_day: window(50),
    seven_day_opus: null,
    limits: [
      { kind: "weekly_all", percent: 50, resets_at: null, scope: null },
      {
        kind: "weekly_scoped",
        percent: 92,
        resets_at: "2026-11-19T02:00:00+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
    ],
  }
  expect(rows(data)).toEqual([
    ["Session", 32],
    ["Week", 50],
    ["Fable", 8],
  ])
  expect(parseUsage(data).limits[2]!.resetsAt).toBe(Date.parse("2026-11-19T02:00:00Z") / 1000)
})

test("keeps the two model rows with the least left, legacy keys included", () => {
  const scoped = (name: string, percent: number) => ({
    kind: "weekly_scoped",
    percent,
    resets_at: null,
    scope: { model: { display_name: name } },
  })
  const data = {
    five_hour: window(0),
    seven_day: window(0),
    seven_day_opus: window(10),
    seven_day_sonnet: window(70),
    limits: [scoped("Fable", 40), scoped("Opus", 95)],
  }
  expect(rows(data).slice(2)).toEqual([
    ["Opus", 5],
    ["Sonnet", 30],
  ])
})

test("a seat billed by spend alone shows its spend and no plan windows", () => {
  const snapshot = parseUsage({
    limits: [],
    spend: {
      enabled: true,
      used: { amount_minor: 48, currency: "USD", exponent: 2 },
      limit: { amount_minor: 4000, currency: "USD", exponent: 2 },
    },
  })
  expect(snapshot.limits).toEqual([])
  expect(snapshot.spend).toEqual({
    used: 0.48,
    limit: 40,
    left: 98.8,
    resetsAt: null,
    reached: false,
  })
})

test("a plan keeps its windows beside extra-usage spend, and ignores spend that's off", () => {
  const spend = (enabled: boolean) => ({
    enabled,
    used: { amount_minor: 5000, exponent: 2 },
    limit: { amount_minor: 5000, exponent: 2 },
  })
  const on = parseUsage({ five_hour: window(20), seven_day: window(30), spend: spend(true) })
  expect(on.limits.map((l) => l.label)).toEqual(["Session", "Week"])
  expect(on.spend).toMatchObject({ left: 0, reached: true })
  expect(
    parseUsage({ five_hour: window(20), seven_day: window(30), spend: spend(false) }).spend,
  ).toBe(null)
})
