import type { RGBA } from "@opentui/core"

import { Canvas } from "~/ui/canvas.tsx"

import type { Bucket, RangeDays } from "./today.ts"

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
            : { ch: BLOCKS[a]!, fg: lowerFg, bg: t > a ? upperFg : null }
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

/** Compact labels drop to the hour, a two-letter weekday, or the day of the month. */
export function bucketLabel(label: string, days: RangeDays, compact = false): string {
  if (days === 1) return compact ? String(Number(label)) : `${label}h`
  const date = bucketDate(label)
  if (compact)
    return days === 7
      ? date.toLocaleDateString("en-US", { weekday: "short" }).slice(0, 2)
      : String(date.getDate())
  return days === 7
    ? `${date.toLocaleDateString("en-US", { weekday: "short" })} ${date.getDate()}`
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

export const bucketDate = (label: string) => {
  const [y = 0, m = 1, d = 1] = label.split("-").map(Number)
  return new Date(y, m - 1, d)
}

type AxisPick = (i: number, buckets: Bucket[]) => boolean
const MIN_DAYS_BEFORE_TODAY = 3

const everyNthHour =
  (n: number): AxisPick =>
  (i) =>
    i % n === 0
const everyNthDayBack =
  (n: number): AxisPick =>
  (i, b) =>
    (b.length - 1 - i) % n === 0
const mondaysAndToday =
  (everyWeeks: number): AxisPick =>
  (i, b) => {
    const daysBack = b.length - 1 - i
    if (daysBack === 0) return true
    return (
      bucketDate(b[i]!.label).getDay() === 1 &&
      daysBack >= MIN_DAYS_BEFORE_TODAY &&
      Math.round(daysBack / 7) % everyWeeks === 0
    )
  }

const AXIS_PICKS: Record<RangeDays, AxisPick[]> = {
  1: [3, 6, 12].map(everyNthHour),
  7: [1, 2].map(everyNthDayBack),
  30: [1, 2].map(mondaysAndToday),
}

/** Full labels when any spacing fits them, else compact ones. */
export function axis(buckets: Bucket[], days: RangeDays, width: number): string {
  for (const compact of [false, true])
    for (const pick of AXIS_PICKS[days]) {
      const labels = buckets.map((b, i) =>
        pick(i, buckets) ? bucketLabel(b.label, days, compact) : null,
      )
      const line = axisLine(labels, width)
      if (line) return line
    }
  return ""
}
