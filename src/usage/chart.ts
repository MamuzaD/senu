import type { RGBA } from "@opentui/core"

import { Canvas } from "~/ui/canvas.tsx"

const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
const MAX_BAR = 8

export interface Stack {
  lower: number
  upper: number
}

export interface BarLayout {
  width: number
  start: (i: number) => number
}

/**
 * Bars of one width spread across the whole width: the first starts at column 0,
 * the last ends at the edge, and the gaps (at least one column) share what's left.
 */
export function barLayout(count: number, width: number): BarLayout {
  if (!count || width < count) return { width: 0, start: () => 0 }
  const bar = Math.max(1, Math.min(MAX_BAR, Math.floor((width - count + 1) / count)))
  const step = count > 1 ? (width - bar) / (count - 1) : 0
  return { width: bar, start: (i) => Math.round(i * step) }
}

/**
 * Two series stacked into one bar per slot, the tallest total filling `rows`.
 * Heights are in eighths of a row. In the cell where the lower series ends, its
 * block is drawn over the upper series' colour as the background, so a cell
 * holds both. Any non-zero value gets at least one eighth.
 */
export function stackedBars(
  stacks: Stack[],
  width: number,
  rows: number,
  lowerFg: RGBA,
  upperFg: RGBA,
): Canvas {
  const canvas = new Canvas(width, rows)
  const max = Math.max(0, ...stacks.map((s) => s.lower + s.upper))
  const { width: bar, start } = barLayout(stacks.length, width)
  if (!max || !bar) return canvas
  const full = rows * 8
  const eighths = (v: number) => (v > 0 ? Math.max(1, Math.round((v / max) * full)) : 0)

  stacks.forEach((s, i) => {
    const lower = eighths(s.lower)
    const total =
      s.upper > 0 ? Math.min(full, Math.max(lower + 1, eighths(s.lower + s.upper))) : lower
    const x0 = start(i)
    for (let row = 0; row < rows; row++) {
      const a = Math.max(0, Math.min(8, lower - row * 8))
      const t = Math.max(0, Math.min(8, total - row * 8))
      if (!t) continue
      const cell =
        a === 8
          ? { ch: "█", fg: lowerFg, bg: null }
          : a === 0
            ? { ch: BLOCKS[t]!, fg: upperFg, bg: null }
            : { ch: BLOCKS[a]!, fg: lowerFg, bg: upperFg }
      for (let col = x0; col < x0 + bar; col++)
        canvas.put(col, rows - 1 - row, cell.ch, cell.fg, { bg: cell.bg })
    }
  })
  return canvas
}

/**
 * One line of labels, each centred under its bar (null leaves a bar unlabelled).
 * A label near an edge shifts inward; null when two labels would touch.
 */
export function axisLine(labels: (string | null)[], width: number): string | null {
  const { width: bar, start: barStart } = barLayout(labels.length, width)
  const line = Array.from({ length: width }, () => " ")
  let free = 0
  for (const [i, text] of labels.entries()) {
    if (!text) continue
    if (text.length > width) return null
    const centred = Math.round(barStart(i) + bar / 2 - text.length / 2)
    const at = Math.max(0, Math.min(width - text.length, centred))
    if (at < free) return null
    for (let c = 0; c < text.length; c++) line[at + c] = text[c]!
    free = at + text.length + 1
  }
  return line.join("")
}
