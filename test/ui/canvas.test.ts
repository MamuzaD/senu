import { describe, expect, test } from "bun:test"

import { Canvas } from "~/ui/canvas.tsx"
import { colors } from "~/ui/theme.ts"

const rows = (c: Canvas) => c.cells.map((row) => row.map((cell) => cell?.ch ?? " ").join(""))

describe("region", () => {
  test("copies a block of the grid, keeping its colors", () => {
    const c = new Canvas(6, 3)
    c.text(0, 0, "abcdef", colors.dim)
    c.text(0, 1, "ghijkl", colors.fg)
    const r = c.region(2, 0, 3, 2)
    expect([r.width, r.height]).toEqual([3, 2])
    expect(rows(r)).toEqual(["cde", "ijk"])
    expect(r.cells[0]![0]!.fg).toBe(colors.dim)
  })
})
