import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { Canvas } from "../../src/ui/canvas.tsx"
import { putQuads } from "../../src/ui/senu.ts"

test("quad palette keeps the bird color in the foreground", () => {
  const colors = ["#000000", "#323232", "#646464", "#969696"].map((hex) => RGBA.fromHex(hex))
  const canvas = new Canvas(1, 1)
  putQuads(canvas, 0, 0, colors, [false, true, false, false])
  expect(canvas.cells[0]![0]!.fg.equals(colors[1]!)).toBe(true)
})
