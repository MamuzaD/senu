import { expect, test } from "bun:test"

import { hopAt, hopDone } from "~/ui/gaze.ts"

const hop = { from: { x: 150, y: 10 }, to: { x: 190, y: 40 }, at: 0 }

test("a hop runs from the snag out along its level and down to the perch", () => {
  expect(hopAt(hop, 0)).toEqual({ ...hop.from, k: 0 })
  const mid = hopAt(hop, 200)
  expect(mid.x).toBeGreaterThan(hop.from.x)
  expect(mid.y - hop.from.y).toBeLessThan(hop.to.y - mid.y)
  expect(hopDone(hop, 10_000)).toBe(true)
  expect(hopAt(hop, 10_000)).toEqual({ ...hop.to, k: 1 })
})
