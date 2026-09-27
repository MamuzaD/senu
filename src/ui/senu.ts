import type { RGBA } from "@opentui/core"

import { Braille, Quad, type Canvas } from "./canvas.tsx"
import {
  PERCH,
  SCENE_ROWS,
  desert,
  night,
  sceneShift,
  type Desert,
  type SceneTime,
} from "./desert.ts"
import { clamp, easeInOut, easeOut, phase, pulse, smooth } from "./motion.ts"
import { brand, hex, mix } from "./theme.ts"

export interface FlightPlan {
  /** ms since the popup opened. */
  t: number
  /** Whether any section is loading or refreshing. */
  busy: boolean
  /** Fresh-data arrival times in ms since opening, used for rings and glints. */
  marks: number[]
  /** Departure time in ms since opening; null until a landing is scheduled. */
  leave: number | null
  /** Reduced motion: the bird is already on the snag. */
  perched: boolean
  time: SceneTime
  /** Scene width in columns, calculated by `sceneCols`. */
  cols: number
}

const FOLD_MS = 330
const MIN_LEAVE_MS = 600
const FLARE_MS = 260

/** True once the bird is still on the snag, so the scene no longer needs animation frames. */
export const flightDone = (p: FlightPlan) =>
  p.perched || (p.leave != null && p.t >= p.leave + arcMs(p.leave) + FOLD_MS)

const LOOP = { cx: 68, cy: 15, rx: 54, ry: 9, lap: 3000, wobble: 1, phase: -8.998, near: 7, far: 3 }
const omega = (2 * Math.PI) / LOOP.lap
const loopAngle = (t: number) => LOOP.phase + omega * t

function loopAt(t: number) {
  const a = loopAngle(t)
  return {
    x: LOOP.cx + LOOP.rx * Math.cos(a),
    y: LOOP.cy + LOOP.ry * Math.sin(a) + LOOP.wobble * Math.sin(2 * a),
    near: (1 - Math.sin(a)) / 2,
  }
}

/** First time after settling when the bird is on the loop's upper left, heading right toward the snag. */
export function leaveAfter(settledAt: number): number {
  let t = Math.max(settledAt, MIN_LEAVE_MS)
  for (let i = 0; i < 400; i++, t += 10) {
    const a = Math.atan2(Math.sin(loopAngle(t)), Math.cos(loopAngle(t)))
    if (a >= -2.6 && a <= -1.3) return t
  }
  return t
}

function wingbeat(t: number) {
  const inLap = t % LOOP.lap
  if (inLap < 720) return -Math.sin((2 * Math.PI * inLap) / 360) * 0.9
  return Math.sin(t / 700) * 0.12
}

const PERCH_DOTS = { x: PERCH.x * 2 + 1, y: PERCH.y * 2 }
const FLARE_FROM = { x: PERCH_DOTS.x + 2, y: PERCH_DOTS.y - 4 }

// Look-ahead shapes the arc; arcTiming derives its travel duration from distance and speed.
const ARC_SHAPE_MS = 940

const LOOP_SPEED = (() => {
  let len = 0
  let p = loopAt(0)
  for (let t = 10; t <= LOOP.lap; t += 10) {
    const q = loopAt(t)
    len += Math.hypot(q.x - p.x, q.y - p.y)
    p = q
  }
  return len / LOOP.lap
})()

function arcPoint(leave: number, u: number) {
  const th = 2.6 * (1 - easeInOut(u))
  const shrink = 1 - u ** 1.6
  const curl = {
    x: FLARE_FROM.x + 16 * shrink * Math.cos(th),
    y: FLARE_FROM.y + 5 * shrink * Math.sin(th),
  }
  const lp = loopAt(leave + u * ARC_SHAPE_MS)
  const w = smooth(u / 0.6)
  return { x: lp.x + (curl.x - lp.x) * w, y: lp.y + (curl.y - lp.y) * w }
}

const arcs = new Map<number, { ms: number; times: number[] }>()
function arcTiming(leave: number) {
  // Preserve loop speed on entry, then decelerate over the final quarter of the arc.
  let timing = arcs.get(leave)
  if (timing) return timing
  const N = 240
  const lens = [0]
  let p = arcPoint(leave, 0)
  for (let i = 1; i <= N; i++) {
    const q = arcPoint(leave, i / N)
    lens.push(lens[i - 1]! + Math.hypot(q.x - p.x, q.y - p.y))
    p = q
  }
  const total = lens[N]!
  const times = [0]
  for (let i = 1; i <= N; i++) {
    const mid = (lens[i - 1]! + lens[i]!) / 2
    const speed = LOOP_SPEED * (1 - 0.65 * smooth((mid / total - 0.75) / 0.25))
    times.push(times[i - 1]! + (lens[i]! - lens[i - 1]!) / speed)
  }
  timing = { ms: times[N]!, times }
  arcs.set(leave, timing)
  return timing
}

/** ms from leaving the loop to touching the perch, including the flare but excluding the fold. */
export const arcMs = (leave: number) => arcTiming(leave).ms + FLARE_MS

function arcU(leave: number, dt: number) {
  const { times } = arcTiming(leave)
  const N = times.length - 1
  if (dt >= times[N]!) return 1
  let lo = 0
  let hi = N
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (times[m]! <= dt) lo = m
    else hi = m
  }
  return (lo + (dt - times[lo]!) / (times[hi]! - times[lo]!)) / N
}

const FLYING = {
  near: {
    glide: ["##...........##", ".####.....####.", "....#######....", ".......#......."],
    up: [
      "##...........##",
      ".###.......###.",
      "...###...###...",
      ".....#####.....",
      ".......#.......",
    ],
    level: [".......#.......", "###############", "......###......", ".......#......."],
    down: [".......#.......", "....#######....", ".####.....####.", "##...........##"],
  },
  mid: {
    glide: ["##.......##", ".###...###.", "...#####...", ".....#....."],
    up: ["##.......##", ".##.....##.", "..##...##..", "...#####...", ".....#....."],
    level: [".....#.....", "###########", ".....#....."],
    down: ["...#####...", ".###...###.", "##.......##"],
  },
  far: {
    glide: ["##...##", ".#####.", "...#..."],
    up: ["#.....#", "##...##", ".##.##.", "...#..."],
    level: ["...#...", "#######"],
    down: ["..###..", ".##.##.", "##...##"],
  },
} as const
const ORIGIN = { glide: 2, up: 3, level: 1, down: 1 } as const

export function flyingPixels(span: number, flap: number): [number, number, boolean][] {
  const size = span >= 6 ? "near" : span >= 4 ? "mid" : "far"
  const pose = flap < -0.4 ? "up" : flap > 0.4 ? "down" : Math.abs(flap) > 0.16 ? "level" : "glide"
  const rows = FLYING[size][pose]
  const half = (rows[0].length - 1) / 2
  const oy = Math.min(ORIGIN[pose], rows.length - 1)
  const out: [number, number, boolean][] = []
  rows.forEach((row, j) =>
    // oxlint-disable-next-line typescript/no-misused-spread -- sprite rows are ASCII
    [...row].forEach((ch, i) => ch === "#" && out.push([i - half, j - oy, false])),
  )
  return out
}

// Quadrant pixels, facing right: #/h body, w wing, o/O talon origin in body/wing color, . empty.
const LANDING = {
  flare: [
    "#...........#",
    "##.........##",
    ".##..###..##.",
    "..####.####..",
    "....#####....",
    ".....#.o.....",
  ],
  touch: [
    ".#.........#.",
    "..##.....##..",
    "...##.##.##..",
    "....#####....",
    ".....###.....",
    ".....#.o.....",
  ],
  fold: ["w.....hh.", ".w...hhhh", "..wwwwhh.", "..wwwwww.", "..wwwwww.", ".wwwww...", "www..O..."],
  perch: [
    "......hh.",
    ".....hhhh",
    "....wwhh.",
    "...wwwwh.",
    "..wwwwww.",
    ".wwwww...",
    "www..O...",
  ],
} as const
export type LandingPose = keyof typeof LANDING

export function landingPixels(pose: LandingPose, facing: 1 | -1): [number, number, boolean][] {
  const rows = LANDING[pose]
  let ox = 0
  let oy = 0
  rows.forEach((row, j) => {
    const i = row.search(/[oO]/)
    if (i >= 0) [ox, oy] = [i, j]
  })
  const out: [number, number, boolean][] = []
  rows.forEach((row, j) =>
    // oxlint-disable-next-line typescript/no-misused-spread -- sprite rows are ASCII
    [...row].forEach(
      (ch, i) => ch !== "." && out.push([(i - ox) * facing, j - oy, ch === "w" || ch === "O"]),
    ),
  )
  return out
}

interface Bird {
  /** Position in braille dots: two across and four down per terminal cell. */
  x: number
  y: number
  near: number
  /** Offsets in quadrant pixels; the boolean selects the wing color. */
  pixels: [number, number, boolean][]
  onLoop: boolean
  flying: boolean
}

function birdAt(t: number, plan: FlightPlan, perch: { x: number; y: number }): Bird {
  const facing = -1
  const land = plan.leave == null ? Infinity : plan.leave + arcMs(plan.leave)
  if (plan.perched || t >= land) {
    const since = plan.perched ? Infinity : t - land
    const pose: LandingPose = since < 140 ? "touch" : since < FOLD_MS ? "fold" : "perch"
    const give = since < 200 ? Math.sin((Math.PI * since) / 200) * 2 : 0
    return {
      x: perch.x,
      y: perch.y + give,
      near: 1,
      pixels: landingPixels(pose, facing),
      onLoop: false,
      flying: false,
    }
  }
  const flareAt = land - FLARE_MS
  const f = FLARE_FROM
  if (plan.leave == null || t <= plan.leave) {
    const p = loopAt(t)
    const span = LOOP.far + (LOOP.near - LOOP.far) * p.near
    return {
      x: p.x,
      y: p.y,
      near: p.near,
      pixels: flyingPixels(span, wingbeat(t)),
      onLoop: true,
      flying: true,
    }
  }
  if (t < flareAt) {
    const u = arcU(plan.leave, t - plan.leave)
    const at = arcPoint(plan.leave, u)
    const n0 = loopAt(plan.leave).near
    const near = n0 + (1 - n0) * smooth(u)
    const span = LOOP.far + (LOOP.near - LOOP.far) * near - 1.5 * pulse(u, 0.3, 0.6)
    const flap = u < 0.25 ? wingbeat(t) * (1 - u / 0.25) : u > 0.85 ? -0.3 : 0
    return {
      x: at.x,
      y: at.y,
      near,
      pixels: flyingPixels(span, flap),
      onLoop: false,
      flying: true,
    }
  }
  const u = easeOut((t - flareAt) / FLARE_MS)
  return {
    x: f.x + (perch.x - f.x) * u,
    y: f.y + (perch.y - f.y) * u - 2 * Math.sin(Math.PI * u),
    near: 1,
    pixels: landingPixels("flare", facing),
    onLoop: false,
    flying: false,
  }
}

export const TONES: Record<
  SceneTime,
  { near: RGBA; far: RGBA; wing: RGBA; glint: RGBA; trail: RGBA; trailEnd: RGBA; ringEnd: RGBA }
> = {
  night: {
    near: brand.papyrus,
    far: brand.dusk,
    wing: hex("#8a6848"),
    glint: brand.gold,
    trail: brand.gold,
    trailEnd: hex("#2f3550"),
    ringEnd: hex("#2a2e44"),
  },
  dawn: {
    near: hex("#f4e4cc"),
    far: hex("#e8cfd8"),
    wing: hex("#8a6a70"),
    glint: brand.gold,
    trail: hex("#ffe0a0"),
    trailEnd: hex("#6a4f86"),
    ringEnd: hex("#7a5a8a"),
  },
  dusk: {
    near: hex("#f6dcc0"),
    far: hex("#e6c4d0"),
    wing: hex("#8a5a5a"),
    glint: brand.gold,
    trail: brand.gold,
    trailEnd: hex("#6a2c62"),
    ringEnd: hex("#7a3a6a"),
  },
  day: {
    near: hex("#5a3822"),
    far: hex("#5e5058"),
    wing: hex("#2e1c12"),
    glint: hex("#c0641e"),
    trail: hex("#b8582a"),
    trailEnd: hex("#b9cfdc"),
    ringEnd: hex("#c4d4de"),
  },
}

const lum = (c: RGBA) => {
  const [r, g, b] = c.toInts()
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

const dist = (a: RGBA | null, b: RGBA | null) => {
  const [ar, ag, ab] = (a ?? night).toInts()
  const [br, bg, bb] = (b ?? night).toInts()
  return Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)
}
const QUADS = [" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"]
export const QUAD_AT = [
  [0, 0, 1],
  [1, 0, 2],
  [0, 1, 4],
  [1, 1, 8],
] as const

const TOP_DOTS = 0x01 | 0x08 | 0x02 | 0x10
const popcount = (b: number) => {
  let n = 0
  for (; b; b &= b - 1) n++
  return n
}

const BIRD_COLOR_WEIGHT = 6

interface QuadPalette {
  foreground: RGBA | null
  background: RGBA | null
  sourceColorCount: number
}

function quadPalette(sub: (RGBA | null)[], bird: boolean[]): QuadPalette {
  const keys: (RGBA | null)[] = []
  for (const s of sub) if (!keys.some((k) => k === s || (k && s && k.equals(s)))) keys.push(s)
  let a = keys[0] ?? null
  let b = keys[1] ?? null
  if (keys.length > 2) {
    let best = Infinity
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        let cost = 0
        sub.forEach(
          (s, k) =>
            (cost +=
              Math.min(dist(s, keys[i]!), dist(s, keys[j]!)) * (bird[k] ? BIRD_COLOR_WEIGHT : 1)),
        )
        if (cost < best) [best, a, b] = [cost, keys[i]!, keys[j]!]
      }
  }
  const hers = sub.find((_, k) => bird[k]) ?? null
  if (a === null || (hers && b && dist(hers, b) < dist(hers, a))) [a, b] = [b, a]
  return { foreground: a, background: b, sourceColorCount: keys.length }
}

/** Renders four quadrant pixels with at most two colors; null leaves the terminal background visible. */
export function putQuads(c: Canvas, x: number, y: number, sub: (RGBA | null)[], bird: boolean[]) {
  const { foreground, background, sourceColorCount } = quadPalette(sub, bird)
  let mask = 0
  sub.forEach((s, k) => {
    if (
      sourceColorCount <= 2
        ? s === foreground || (s && foreground && s.equals(foreground))
        : dist(s, foreground) <= dist(s, background)
    )
      mask |= QUAD_AT[k]![2]
  })
  if (!foreground) return
  if (mask === 15) c.put(x, y, "█", foreground)
  else c.put(x, y, QUADS[mask]!, foreground, background ? { bg: background } : {})
}

type Tone = (typeof TONES)[SceneTime]

function isBacklit(scene: Desert, bird: Bird, time: SceneTime): boolean {
  let sum = 0
  let n = 0
  for (const [dx, dy] of bird.pixels) {
    const u = scene.px.get(Math.floor((bird.x + dx) / 2), Math.round(bird.y / 2 + dy))
    if (u) {
      sum += lum(u)
      n++
    }
  }
  return time !== "day" && n > 0 && sum / n > (time === "night" ? 0.55 : 0.5)
}

function paintTrail(plan: FlightPlan, tone: Tone, at: (t: number) => Bird, sx: number): Braille {
  const { t, cols } = plan
  const trail = new Braille(cols, SCENE_ROWS)
  if (!plan.perched) {
    const cool = plan.leave == null ? 1 : 1 - smooth(phase(t, plan.leave, arcMs(plan.leave)))
    const N = 60
    if (cool > 0)
      for (let k = N; k >= 1; k--) {
        const u = t - k * 22
        if (u < 0) continue
        const p = at(u)
        if (!p.flying) continue
        const f = 1 - k / N
        const col = mix(
          tone.trailEnd,
          mix(mix(tone.trailEnd, tone.trail, 0.5 + 0.5 * p.near), tone.trail, f),
          f * cool,
        )
        trail.dot(p.x, p.y, col, 5 + f * 10)
        if (f > 0.55) trail.dot(p.x, p.y + 1, col, 5 + f * 10)
      }

    for (const mark of plan.marks) {
      const age = t - mark
      if (age < 0 || age > 900) continue
      const p = loopAt(mark)
      const r = 2 + age / 60
      for (let a = 0; a < Math.PI * 2; a += 0.12)
        trail.dot(
          p.x + sx + r * Math.cos(a),
          p.y + r * Math.sin(a) * 0.55,
          mix(tone.trail, tone.ringEnd, age / 900),
          20,
        )
    }
  }
  return trail
}

function paintBird(plan: FlightPlan, tone: Tone, bird: Bird): { back: Quad; front: Quad } {
  const back = new Quad(plan.cols, SCENE_ROWS)
  const front = new Quad(plan.cols, SCENE_ROWS)
  const lastLand = plan.marks.length ? Math.max(...plan.marks) : null
  const glint = plan.perched ? 0 : pulse(plan.t, lastLand, 600)
  const color = mix(mix(tone.far, tone.near, clamp(bird.near * 1.3 - 0.15)), tone.glint, glint)
  const wing = mix(color, tone.wing, 0.5)
  const layer = bird.onLoop && bird.near < 0.45 ? back : front
  for (const [dx, dy, w] of bird.pixels) layer.set(bird.x + dx, bird.y / 2 + dy, w ? wing : color)
  return { back, front }
}

function compositeScene(
  c: Canvas,
  scene: Desert,
  trail: Braille,
  layers: { back: Quad; front: Quad },
  backlit: boolean,
  cols: number,
) {
  const { back, front } = layers
  const veils = (x: number, y: number) => scene.treeAt(x, y) || scene.orbAt(x, y)
  for (let r = 0; r < SCENE_ROWS; r++)
    for (let x = 0; x < cols; x++) {
      const top = scene.px.get(x, r * 2)
      const bot = scene.px.get(x, r * 2 + 1)
      const sub: (RGBA | null)[] = []
      const hers: boolean[] = []
      for (const [dx, dy] of QUAD_AT) {
        const under = scene.px.get(x, r * 2 + dy)
        const open = !under || !scene.treeAt(x, r * 2 + dy)
        const her =
          front.px[r * 2 + dy]?.[x * 2 + dx] ??
          (open ? (back.px[r * 2 + dy]?.[x * 2 + dx] ?? null) : null)
        sub.push(
          her
            ? under && (scene.orbAt(x, r * 2 + dy) || backlit)
              ? mix(night, her, 0.12)
              : her
            : under,
        )
        hers.push(!!her)
      }
      if (hers.some(Boolean)) {
        putQuads(c, x, r, sub, hers)
        continue
      }
      const veiled = (top && veils(x, r * 2)) || (bot && veils(x, r * 2 + 1))
      const tb = veiled ? 0 : (trail.bits[r]?.[x] ?? 0)
      const ground = top && bot ? mix(top, bot, 0.5) : (top ?? bot)
      const fg = tb ? trail.color[r]![x]! : null
      if (tb && top && bot && dist(top, bot) > 64) {
        if (top.equals(bot)) c.put(x, r, "█", top)
        else c.put(x, r, "▀", top, { bg: bot })
      } else if (tb && top && bot) {
        const nt = popcount(tb & TOP_DOTS)
        const k = nt / popcount(tb)
        c.put(x, r, String.fromCharCode(0x2800 + tb), fg!, { bg: mix(top, bot, k) })
      } else if (tb)
        c.put(x, r, String.fromCharCode(0x2800 + tb), fg!, ground ? { bg: ground } : {})
      else if (top && bot) {
        const star = scene.glyphs.find((g) => g.x === x && g.row === r)
        if (star) c.put(x, r, star.ch, star.fg, { bg: mix(top, bot, 0.5) })
        else if (top.equals(bot)) c.put(x, r, "█", top)
        else c.put(x, r, "▀", top, { bg: bot })
      } else if (top) c.put(x, r, "▀", top)
      else if (bot) c.put(x, r, "▄", bot)
    }
}

/** Paints into a canvas sized plan.cols by SCENE_ROWS terminal cells; plan times are ms since opening. */
export function paintSky(c: Canvas, plan: FlightPlan) {
  const scene = desert(c, { t: plan.t, busy: plan.busy, time: plan.time, cols: plan.cols })
  const tone = TONES[plan.time]
  const sx = sceneShift(plan.cols) * 2
  const at = (t: number) => {
    const bird = birdAt(t, plan, PERCH_DOTS)
    return { ...bird, x: bird.x + sx }
  }
  const bird = at(plan.t)
  compositeScene(
    c,
    scene,
    paintTrail(plan, tone, at, sx),
    paintBird(plan, tone, bird),
    isBacklit(scene, bird, plan.time),
    plan.cols,
  )
}
