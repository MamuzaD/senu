import type { RGBA } from "@opentui/core"

import { Braille, Quad, type Canvas } from "./canvas.tsx"
import { clamp, easeInOut, easeOut } from "./motion.ts"
import { QUAD_AT, TONES, flyingPixels, landingPixels, putQuads } from "./senu.ts"
import { brand, mix } from "./theme.ts"

const LAUNCH_MS = 60
const STOOP_MS = 240
const RING_MS = 80
export const DIVE_MS = LAUNCH_MS + STOOP_MS + RING_MS

/** Positions are cell coordinates; `perch` holds the talons and `target` is the chosen row's dot. */
export interface DivePlan {
  /** ms since Enter, or null while perched. */
  t: number | null
  perch: { x: number; y: number }
  target: { x: number; y: number }
}

const STOOP = ["......ww", "....wwww", "..hwww..", ".hhw....", "hh......"]
const SWEEP = ["...www....", ".hhwwwwww.", "hh..www..."]

function spritePixels(rows: string[], ox: number, oy: number): [number, number, boolean][] {
  const out: [number, number, boolean][] = []
  rows.forEach((row, j) =>
    // oxlint-disable-next-line typescript/no-misused-spread -- sprite rows are ASCII
    [...row].forEach((ch, i) => ch !== "." && out.push([i - ox, j - oy, ch === "w"])),
  )
  return out
}
const STOOP_PX = spritePixels(STOOP, 1, 4)
const SWEEP_PX = spritePixels(SWEEP, 0, 2)

function path(plan: DivePlan, k: number) {
  const p0 = { x: plan.perch.x * 2, y: plan.perch.y * 2 - 3 }
  const p2 = { x: plan.target.x * 2 + 2, y: plan.target.y * 2 + 1 }
  const p1 = { x: p0.x, y: p2.y }
  const a = (1 - k) ** 2
  const b = 2 * k * (1 - k)
  const c = k * k
  const at = { x: a * p0.x + b * p1.x + c * p2.x, y: a * p0.y + b * p1.y + c * p2.y }
  const dx = 2 * (1 - k) * (p1.x - p0.x) + 2 * k * (p2.x - p1.x)
  const dy = 2 * (1 - k) * (p1.y - p0.y) + 2 * k * (p2.y - p1.y)
  return { ...at, steep: Math.abs(dy) > Math.abs(dx) * 0.8 }
}

const stoopK = (t: number) => easeInOut(clamp((t - LAUNCH_MS) / STOOP_MS))

/** Returns the first highlighted column and its glow strength; `Infinity` means no row is lit. */
export function rowGlow(plan: DivePlan): { from: number; k: number } {
  if (plan.t == null) return { from: Infinity, k: 0 }
  const k = stoopK(plan.t)
  const at = path(plan, k)
  const onRow = at.y >= plan.target.y * 2 - 1
  if (!onRow) return { from: Infinity, k: 0 }
  if (plan.t >= LAUNCH_MS + STOOP_MS) return { from: 0, k: 1 }
  return { from: Math.floor(at.x / 2), k: 0.85 }
}

export const diveDone = (plan: DivePlan) => plan.t != null && plan.t >= DIVE_MS

export function paintSenu(c: Canvas, plan: DivePlan) {
  const tone = TONES.night
  const body = tone.near
  const quad = new Quad(c.width, c.height)
  const trail = new Braille(c.width, c.height)
  const t = plan.t

  let pixels: [number, number, boolean][] | null
  let at: { x: number; y: number }
  if (t == null) {
    pixels = landingPixels("perch", -1)
    at = { x: plan.perch.x * 2, y: plan.perch.y * 2 }
  } else if (t < LAUNCH_MS) {
    pixels = flyingPixels(7, -0.9)
    at = { x: plan.perch.x * 2, y: plan.perch.y * 2 - 3 * easeOut(t / LAUNCH_MS) }
  } else if (t < LAUNCH_MS + STOOP_MS) {
    const p = path(plan, stoopK(t))
    pixels = p.steep ? STOOP_PX : SWEEP_PX
    at = p
  } else {
    pixels = null
    at = { x: plan.target.x * 2 + 1, y: plan.target.y * 2 + 1 }
  }

  if (t != null) {
    const N = 10
    for (let i = N; i >= 1; i--) {
      const u = t - i * 10
      if (u < LAUNCH_MS || u > LAUNCH_MS + STOOP_MS) continue
      const p = path(plan, stoopK(u))
      const f = 1 - i / N
      const col = mix(brand.shadow, brand.gold, f)
      trail.dot(p.x, p.y * 2 + 1, col, f * 10)
      trail.dot(p.x + 1, p.y * 2 + 1, col, f * 10)
    }
    const ringT = t - LAUNCH_MS - STOOP_MS
    if (ringT >= 0 && ringT <= RING_MS) {
      const k = ringT / RING_MS
      const r = 2 + 5 * easeOut(k)
      const cx = plan.target.x * 2 + 1
      const cy = plan.target.y * 4 + 2
      for (let a = 0; a < Math.PI * 2; a += 0.2)
        trail.dot(
          cx + r * Math.cos(a),
          cy + r * 0.9 * Math.sin(a),
          mix(brand.gold, brand.shadow, k),
          20,
        )
    }
  }

  const glint = t == null ? 0 : clamp(t / (LAUNCH_MS + STOOP_MS))
  const color = mix(body, brand.gold, glint * 0.6)
  if (pixels)
    for (const [dx, dy, w] of pixels)
      quad.set(at.x + dx, at.y + dy, w ? mix(color, tone.wing, 0.5) : color)

  for (let r = 0; r < c.height; r++)
    for (let x = 0; x < c.width; x++) {
      const sub: (RGBA | null)[] = []
      const hers: boolean[] = []
      for (const [dx, dy] of QUAD_AT) {
        const p = quad.px[r * 2 + dy]?.[x * 2 + dx] ?? null
        sub.push(p)
        hers.push(!!p)
      }
      if (hers.some(Boolean)) {
        putQuads(c, x, r, sub, hers)
        continue
      }
      const bits = trail.bits[r]?.[x] ?? 0
      const under = c.cells[r]![x]
      if (bits && (!under || under.ch === " "))
        c.put(x, r, String.fromCharCode(0x2800 + bits), trail.color[r]![x]!)
    }
}
