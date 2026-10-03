import type { RGBA } from "@opentui/core"

import { Quad, type Canvas, type Cell } from "./canvas.tsx"
import { SCENE_ROWS, type SceneTime } from "./desert.ts"
import { clamp, easeInOut, running, smooth, tween } from "./motion.ts"
import { QUAD_AT, TONES, flyingPixels, landingPixels, putQuads } from "./senu.ts"
import { brand, mix } from "./theme.ts"

/** Quadrant pixels on the popup's screen: two across and two down per terminal cell. */
export interface Point {
  x: number
  y: number
}

/** One flight between perches; `at` is the start on the now() clock, in ms. */
export interface Hop {
  from: Point
  to: Point
  at: number
}

const TOUCH_MS = 140
/** Share of the hop after which wings spread to brake, as on the sky's landing. */
const FLARE_AT = 0.8
const hopMs = (h: Hop) =>
  clamp(180 + 5 * Math.hypot(h.to.x - h.from.x, h.to.y - h.from.y), 250, 650)

/** Where the bird is along the hop, and how far through it, 0 to 1. */
export function hopAt(h: Hop, t: number): Point & { k: number } {
  const k = tween(h.at, hopMs(h), easeInOut, t)
  // Out along the higher perch's level, then down the far column, or the reverse on the way back.
  const bend = { x: Math.max(h.from.x, h.to.x), y: Math.min(h.from.y, h.to.y) }
  const a = (1 - k) ** 2
  const b = 2 * k * (1 - k)
  const c = k * k
  return {
    x: a * h.from.x + b * bend.x + c * h.to.x,
    y: a * h.from.y + b * bend.y + c * h.to.y,
    k,
  }
}

export const hopDone = (h: Hop, t: number) => hopAt(h, t).k >= 1

/** True while the hop or its touchdown still needs animation frames. */
export const hopRunning = (h: Hop, t: number) => running(h.at, hopMs(h) + TOUCH_MS, t)

/** The quadrant color a cell shows at row half `dy`, so the bird can sit over the scene. */
function under(cell: Cell | null | undefined, dy: number): RGBA | null {
  if (!cell) return null
  if (cell.ch === "█") return cell.fg
  if (cell.ch === "▀") return dy === 0 ? cell.fg : cell.bg
  if (cell.ch === "▄") return dy === 1 ? cell.fg : cell.bg
  return cell.bg
}

/**
 * Paints the hopping or perched bird into `c`, whose top left cell sits at
 * `origin` on the screen; parts outside the canvas are left to other canvases.
 */
export function paintHop(c: Canvas, h: Hop, t: number, time: SceneTime, origin: Point) {
  const at = hopAt(h, t)
  const pixels =
    at.k < FLARE_AT
      ? flyingPixels(5, Math.sin(t / 55) * 0.9)
      : landingPixels(at.k < 1 ? "flare" : hopRunning(h, t) ? "touch" : "perch", -1)
  // The scene's tone inside the sky, the agents picker's night tone over the terminal.
  const tone = (k: number, key: "near" | "wing") => mix(TONES[time][key], TONES.night[key], k)
  const out = smooth((at.y - (SCENE_ROWS * 2 - 6)) / 8)
  const body = mix(tone(out, "near"), brand.gold, 0.5 * Math.sin(Math.PI * at.k))
  const wing = mix(body, tone(out, "wing"), 0.5)

  const quad = new Quad(c.width, c.height)
  for (const [dx, dy, w] of pixels)
    quad.set(at.x - origin.x * 2 + dx, at.y - origin.y * 2 + dy, w ? wing : body)
  for (let r = 0; r < c.height; r++)
    for (let x = 0; x < c.width; x++) {
      const hers = QUAD_AT.map(([dx, dy]) => quad.px[r * 2 + dy]![x * 2 + dx] != null)
      if (!hers.some(Boolean)) continue
      const sub = QUAD_AT.map(
        ([dx, dy]) => quad.px[r * 2 + dy]![x * 2 + dx] ?? under(c.cells[r]![x], dy),
      )
      putQuads(c, x, r, sub, hers)
    }
}
