import { describe, expect, test } from "bun:test"

import { RGBA } from "@opentui/core"

import type { Canvas } from "~/ui/canvas.tsx"
import { axisLine, barLayout, stackedBars } from "~/usage/chart.ts"

const low = RGBA.fromHex("#0000ff")
const high = RGBA.fromHex("#ff8000")
const columnTopDown = (c: Canvas, x: number) => c.cells.map((row) => row[x] ?? null)

describe("stackedBars", () => {
  test("the tallest total fills every row", () => {
    const col = columnTopDown(stackedBars([{ lower: 2, upper: 0 }], 1, 2, low, high), 0)
    expect(col.map((cell) => cell?.ch)).toEqual(["█", "█"])
    expect(col.every((cell) => cell?.fg.equals(low))).toBe(true)
  })

  test("the cell where the lower series ends shows both colours", () => {
    const [top, bottom] = columnTopDown(stackedBars([{ lower: 1, upper: 3 }], 1, 2, low, high), 0)
    expect(bottom?.ch).toBe("▄")
    expect(bottom?.fg.equals(low)).toBe(true)
    expect(bottom?.bg?.equals(high)).toBe(true)
    expect(top?.ch).toBe("█")
    expect(top?.fg.equals(high)).toBe(true)
  })

  test("a tiny value still gets an eighth", () => {
    const c = stackedBars(
      [
        { lower: 100, upper: 0 },
        { lower: 0.01, upper: 0 },
      ],
      2,
      1,
      low,
      high,
    )
    expect(columnTopDown(c, 1)[0]?.ch).toBe("▁")
  })

  test("nothing to draw leaves the canvas empty", () => {
    const c = stackedBars([{ lower: 0, upper: 0 }], 4, 2, low, high)
    expect(c.cells.flat().every((cell) => cell === null)).toBe(true)
  })
})

test("barLayout spreads bars from edge to edge", () => {
  const ends = (count: number, width: number) => {
    const { width: bar, start } = barLayout(count, width)
    return { bar, first: start(0), lastEnd: start(count - 1) + bar }
  }
  expect(ends(30, 93)).toEqual({ bar: 2, first: 0, lastEnd: 93 })
  expect(ends(24, 93)).toEqual({ bar: 2, first: 0, lastEnd: 93 })
  expect(ends(7, 93)).toEqual({ bar: 8, first: 0, lastEnd: 93 })
  const { width: bar, start } = barLayout(30, 93)
  for (let i = 1; i < 30; i++) expect(start(i) - start(i - 1)).toBeGreaterThan(bar)
  expect(barLayout(0, 93).width).toBe(0)
})

describe("axisLine", () => {
  test("centres each label under its bar", () => {
    expect(axisLine(["a", "b", "c"], 14)).toBe("  a    b    c ")
  })

  test("shifts labels at the edges inward", () => {
    expect(axisLine(["Wed 30", null, "Thu 31"], 16)).toBe("Wed 30    Thu 31")
  })

  test("gives up when labels would touch", () => {
    expect(axisLine(["Sep 1", "Sep 2", "Sep 3"], 12)).toBeNull()
  })
})
