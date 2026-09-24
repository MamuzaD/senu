import type { RGBA } from "@opentui/core"
import { Braille, Quad, type Canvas } from "./canvas.tsx"
import { SCENE_COLS, SCENE_ROWS, desert, night, type SceneTime } from "./desert.ts"
import { clamp, easeInOut, easeOut, phase, pulse, smooth } from "./motion.ts"
import { brand, hex, mix } from "./theme.ts"

/**
 * Senu over the desert. While anything is loading or refreshing she circles
 * a wide loop, seen from the ground by the campfire: the near arc high and
 * large, the far arc lower, smaller and dusk-coloured, with a gold comet
 * trail behind her. Nothing in the distance can hide her (she's close
 * overhead); only the snag in the foreground can. Once nothing is busy she
 * eases off the loop into one arc round the snag, flares, folds and perches
 * facing the moon, and the scene is still. Everything is a pure function of
 * the plan, so a frame can be drawn for any moment.
 */
export interface FlightPlan {
  /** ms since the popup opened */
  t: number
  /** any section loading or refreshing */
  busy: boolean
  /** when each landing happened (fresh data arriving), for the rings and the glint */
  marks: number[]
  /** when she breaks off the loop for the snag, once nothing is busy */
  leave: number | null
  /** reduced motion: she is simply on the snag */
  perched: boolean
  /** the night desert or the day one */
  time: SceneTime
}

/** From breaking off the loop to her talons touching the snag. */
export const ARC_MS = 1200
/** From touching to folded and still. */
const FOLD_MS = 330
/** She never breaks off sooner than this after opening, so a fresh open still shows her flying in. */
const MIN_LEAVE_MS = 600
const FLARE_MS = 260

/** Is the flight over (she's folded on the snag), so nothing needs drawing again? */
export const flightDone = (p: FlightPlan) => p.perched || (p.leave != null && p.t >= p.leave + ARC_MS + FOLD_MS)

// ------------------------------------------------------------------- the loop

/** The loop, in braille dots (2 per column, 4 per row). */
const LOOP = { cx: 68, cy: 15, rx: 54, ry: 9, lap: 3000, wobble: 1, phase: -8.998, near: 7, far: 3 }
const omega = (2 * Math.PI) / LOOP.lap
const loopAngle = (t: number) => LOOP.phase + omega * t

function loopAt(t: number) {
  const a = loopAngle(t)
  return {
    x: LOOP.cx + LOOP.rx * Math.cos(a),
    y: LOOP.cy + LOOP.ry * Math.sin(a) + LOOP.wobble * Math.sin(2 * a),
    // 0 on the far (lower) arc, 1 on the near (upper) arc
    near: (1 - Math.sin(a)) / 2,
  }
}

/**
 * When she can break off once nothing is busy: the first moment at or after
 * `settledAt` that she's on the upper left of the loop heading right, so the
 * arc always carries her the same way round the snag.
 */
export function leaveAfter(settledAt: number): number {
  let t = Math.max(settledAt, MIN_LEAVE_MS)
  for (let i = 0; i < 400; i++, t += 10) {
    const a = Math.atan2(Math.sin(loopAngle(t)), Math.cos(loopAngle(t)))
    if (a >= -2.6 && a <= -1.3) return t
  }
  return t
}

/** A wingbeat that mostly glides: two beats a lap, then a held soar. */
function wingbeat(t: number) {
  const inLap = t % LOOP.lap
  if (inLap < 720) return -Math.sin((2 * Math.PI * inLap) / 360) * 0.9
  return Math.sin(t / 700) * 0.12
}

const hermite = (p0: number, v0: number, p1: number, v1: number, u: number) => {
  const u2 = u * u
  const u3 = u2 * u
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * v0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * v1
}

// ---------------------------------------------------------------- her sprites

/**
 * In flight, seen from below, hand-set in quadrant pixels (tall: 5×10 on
 * screen) in three sizes and four poses; `ORIGIN` is the row on her flight line.
 */
const FLYING = {
  near: {
    glide: ["##...........##", ".####.....####.", "....#######....", ".......#......."],
    up: ["##...........##", ".###.......###.", "...###...###...", ".....#####.....", ".......#......."],
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

function flyingPixels(span: number, flap: number): [number, number, boolean][] {
  const size = span >= 6 ? "near" : span >= 4 ? "mid" : "far"
  const pose = flap < -0.4 ? "up" : flap > 0.4 ? "down" : Math.abs(flap) > 0.16 ? "level" : "glide"
  const rows = FLYING[size][pose]
  const half = (rows[0]!.length - 1) / 2
  const oy = Math.min(ORIGIN[pose], rows.length - 1)
  const out: [number, number, boolean][] = []
  rows.forEach((row, j) => [...row].forEach((ch, i) => ch === "#" && out.push([i - half, j - oy, false])))
  return out
}

/**
 * Landing, facing right (mirrored to face the moon). `#` and `h` are her pale
 * head and breast, `w` her folded wing a shade darker; `o` marks her talons
 * (`O` in wing tone). The flare flings her wings up and wide with her legs
 * down; touch closes them; fold draws them over her back; then she perches
 * in profile, hooked head forward, tail hanging past the branch.
 */
const LANDING = {
  flare: ["#...........#", "##.........##", ".##..###..##.", "..####.####..", "....#####....", ".....#.o....."],
  touch: [".#.........#.", "..##.....##..", "...##.##.##..", "....#####....", ".....###.....", ".....#.o....."],
  fold: ["w.....hh.", ".w...hhhh", "..wwwwhh.", "..wwwwww.", "..wwwwww.", ".wwwww...", "www..O..."],
  perch: ["......hh.", ".....hhhh", "....wwhh.", "...wwwwh.", "..wwwwww.", ".wwwww...", "www..O..."],
} as const
type LandingPose = keyof typeof LANDING

function landingPixels(pose: LandingPose, facing: 1 | -1): [number, number, boolean][] {
  const rows = LANDING[pose]
  let ox = 0
  let oy = 0
  rows.forEach((row, j) => {
    const i = row.search(/[oO]/)
    if (i >= 0) [ox, oy] = [i, j]
  })
  const out: [number, number, boolean][] = []
  rows.forEach((row, j) =>
    [...row].forEach((ch, i) => ch !== "." && out.push([(i - ox) * facing, j - oy, ch === "w" || ch === "O"])),
  )
  return out
}

interface Bird {
  /** in braille dots; her quad pixel is (x, y / 2) */
  x: number
  y: number
  near: number
  pixels: [number, number, boolean][]
  onLoop: boolean
  flying: boolean
}

/** Where she is and how she holds herself. `perch` is in dots; she lands facing left, toward the moon. */
function birdAt(t: number, plan: FlightPlan, perch: { x: number; y: number }): Bird {
  const facing = -1
  const land = plan.leave == null ? Infinity : plan.leave + ARC_MS
  if (plan.perched || t >= land) {
    const since = plan.perched ? Infinity : t - land
    const pose: LandingPose = since < 140 ? "touch" : since < FOLD_MS ? "fold" : "perch"
    // the branch gives a little under her as she takes it
    const give = since < 200 ? Math.sin((Math.PI * since) / 200) * 2 : 0
    return { x: perch.x, y: perch.y + give, near: 1, pixels: landingPixels(pose, facing), onLoop: false, flying: false }
  }
  const flareAt = land - FLARE_MS
  // the flare begins just beyond the perch and above it, so she comes in toward the moon
  const f = { x: perch.x - facing * 2, y: perch.y - 4 }
  if (plan.leave == null || t <= plan.leave) {
    const p = loopAt(t)
    const span = LOOP.far + (LOOP.near - LOOP.far) * p.near
    return { x: p.x, y: p.y, near: p.near, pixels: flyingPixels(span, wingbeat(t)), onLoop: true, flying: true }
  }
  if (t < flareAt) {
    // one continuous arc: the circling eases into a curl that swings in front
    // of the snag, round its far side and in over the top, closing on the flare
    const u = (t - plan.leave) / (flareAt - plan.leave)
    const th = 2.6 * (1 - easeInOut(u))
    const shrink = 1 - u ** 1.6
    const curl = { x: f.x + 16 * shrink * Math.cos(th), y: f.y + 5 * shrink * Math.sin(th) }
    const lp = loopAt(t)
    const w = smooth(u / 0.6)
    const n0 = loopAt(plan.leave).near
    const near = n0 + (1 - n0) * smooth(u)
    const span = LOOP.far + (LOOP.near - LOOP.far) * near - 1.5 * pulse(u, 0.3, 0.6)
    const flap = u < 0.25 ? wingbeat(t) * (1 - u / 0.25) : u > 0.85 ? -0.3 : 0
    return {
      x: lp.x + (curl.x - lp.x) * w,
      y: lp.y + (curl.y - lp.y) * w,
      near,
      pixels: flyingPixels(span, flap),
      onLoop: false,
      flying: true,
    }
  }
  // the flare: she stalls onto the broken top, talons first
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

// ------------------------------------------------------------------ composite

/**
 * Her colours and her trail's. By night she's pale papyrus near and dusk far
 * with a gold comet; by day, against the bright haze, she's a warm dark brown
 * with a rust trail that fades into the sky. Over the moon or the sun she's a
 * dark silhouette either way.
 */
const TONES: Record<SceneTime, { near: RGBA; far: RGBA; wing: RGBA; glint: RGBA; trail: RGBA; trailEnd: RGBA; route: RGBA; routeEnd: RGBA; ringEnd: RGBA }> = {
  night: {
    near: brand.papyrus,
    far: brand.dusk,
    wing: hex("#8a6848"),
    glint: brand.gold,
    trail: brand.gold,
    trailEnd: hex("#2f3550"),
    route: hex("#2a2f48"),
    routeEnd: hex("#1f2335"),
    ringEnd: hex("#2a2e44"),
  },
  day: {
    near: hex("#5a3822"),
    far: hex("#5e5058"),
    wing: hex("#2e1c12"),
    glint: hex("#c0641e"),
    trail: hex("#b8582a"),
    trailEnd: hex("#b9cfdc"),
    route: hex("#9ab6cc"),
    routeEnd: hex("#b4cadb"),
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
const QUAD_AT = [
  [0, 0, 1],
  [1, 0, 2],
  [0, 1, 4],
  [1, 1, 8],
] as const

/**
 * Put one cell from four quadrant pixels, choosing the two colours that lose
 * the least (her pixels weigh most). Null is the terminal's own background.
 */
function putQuads(c: Canvas, x: number, y: number, sub: (RGBA | null)[], bird: boolean[]) {
  const keys: (RGBA | null)[] = []
  for (const s of sub) if (!keys.some((k) => k === s || (k && s && k.equals(s)))) keys.push(s)
  let a = keys[0] ?? null
  let b = keys[1] ?? null
  if (keys.length > 2) {
    let best = Infinity
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        let cost = 0
        sub.forEach((s, k) => (cost += Math.min(dist(s, keys[i]!), dist(s, keys[j]!)) * (bird[k] ? 6 : 1)))
        if (cost < best) [best, a, b] = [cost, keys[i]!, keys[j]!]
      }
  }
  // her colour goes in front; the terminal background can only be the back
  const hers = sub.find((_, k) => bird[k]) ?? null
  if (a === null || (hers && b && dist(hers, b) < dist(hers, a))) [a, b] = [b, a]
  let mask = 0
  sub.forEach((s, k) => {
    if (keys.length <= 2 ? s === a || (s && a && s.equals(a)) : dist(s, a) <= dist(s, b)) mask |= QUAD_AT[k]![2]
  })
  if (!a) return
  if (mask === 15) c.put(x, y, "█", a)
  else c.put(x, y, QUADS[mask]!, a, b ? { bg: b } : {})
}

/** Paint the desert and Senu for the plan into a `SCENE_COLS × SCENE_ROWS` canvas. */
export function paintSky(c: Canvas, plan: FlightPlan) {
  const { t } = plan
  const scene = desert(c, { t, busy: plan.busy, time: plan.time })
  const tone = TONES[plan.time]
  // over anything bright by night (the moon), over the sun by day, she goes dark
  const glare = (x: number, y: number, under: RGBA) => (plan.time === "night" ? lum(under) > 0.55 : scene.orbAt(x, y))
  const perch = { x: scene.perch.x * 2 + 1, y: scene.perch.y * 2 }
  const back = new Quad(SCENE_COLS, SCENE_ROWS)
  const front = new Quad(SCENE_COLS, SCENE_ROWS)
  const trail = new Braille(SCENE_COLS, SCENE_ROWS)
  const bird = birdAt(t, plan, perch)

  if (!plan.perched) {
    // the dotted route of the loop while she's on it
    const fade = plan.leave == null ? 1 : 1 - phase(t, plan.leave - 150, 900)
    if (fade > 0)
      for (let u = 0; u < LOOP.lap; u += 34) {
        const p = loopAt(u)
        trail.dot(p.x, p.y, mix(tone.routeEnd, tone.route, fade * (0.55 + 0.45 * p.near)), 1)
      }

    // the comet: where she's been, gold at her tail, cooling as she comes in to land
    const cool = plan.leave == null ? 1 : 1 - smooth(phase(t, plan.leave, ARC_MS))
    const N = 60
    if (cool > 0)
      for (let k = N; k >= 1; k--) {
        const u = t - k * 22
        if (u < 0) continue
        const p = birdAt(u, plan, perch)
        if (!p.flying) continue
        const f = 1 - k / N
        const col = mix(tone.trailEnd, mix(mix(tone.trailEnd, tone.trail, 0.5 + 0.5 * p.near), tone.trail, f), f * cool)
        trail.dot(p.x, p.y, col, 5 + f * 10)
        if (f > 0.55) trail.dot(p.x, p.y + 1, col, 5 + f * 10)
      }

    // a ring opens where she was as each section lands
    for (const at of plan.marks) {
      const age = t - at
      if (age < 0 || age > 900) continue
      const p = loopAt(at)
      const r = 2 + age / 60
      for (let a = 0; a < Math.PI * 2; a += 0.12)
        trail.dot(p.x + r * Math.cos(a), p.y + r * Math.sin(a) * 0.55, mix(tone.trail, tone.ringEnd, age / 900), 20)
    }
  }

  const lastLand = plan.marks.length ? Math.max(...plan.marks) : null
  const glint = plan.perched ? 0 : pulse(t, lastLand, 600)
  const color = mix(mix(tone.far, tone.near, clamp(bird.near * 1.3 - 0.15)), tone.glint, glint)
  const wing = mix(color, tone.wing, 0.5)
  const layer = bird.onLoop && bird.near < 0.45 ? back : front
  for (const [dx, dy, w] of bird.pixels) layer.set(bird.x + dx, bird.y / 2 + dy, w ? wing : color)

  // Only the snag can hide her on the far side of the loop; over the moon
  // nothing does. The trail crosses the distant scene but dies in the moon's
  // glare and behind the snag.
  const hides = (x: number, y: number) => scene.treeAt(x, y) && !scene.orbAt(x, y)
  const veils = (x: number, y: number) => scene.treeAt(x, y) || scene.orbAt(x, y)
  for (let r = 0; r < SCENE_ROWS; r++)
    for (let x = 0; x < SCENE_COLS; x++) {
      const top = scene.px.get(x, r * 2)
      const bot = scene.px.get(x, r * 2 + 1)
      const sub: (RGBA | null)[] = []
      const hers: boolean[] = []
      for (const [dx, dy] of QUAD_AT) {
        const under = scene.px.get(x, r * 2 + dy)
        const open = !under || !hides(x, r * 2 + dy)
        const her = front.px[r * 2 + dy]?.[x * 2 + dx] ?? (open ? (back.px[r * 2 + dy]?.[x * 2 + dx] ?? null) : null)
        sub.push(her ? (under && glare(x, r * 2 + dy, under) ? mix(night, her, 0.12) : her) : under)
        hers.push(!!her)
      }
      if (hers.some(Boolean)) {
        putQuads(c, x, r, sub, hers)
        continue
      }
      const veiled = (top && veils(x, r * 2)) || (bot && veils(x, r * 2 + 1))
      const tb = veiled ? 0 : (trail.bits[r]?.[x] ?? 0)
      const ground = top && bot ? mix(top, bot, 0.5) : (top ?? bot)
      if (tb) c.put(x, r, String.fromCharCode(0x2800 + tb), trail.color[r]![x]!, ground ? { bg: ground } : {})
      else if (top && bot) {
        if (top.equals(bot)) c.put(x, r, "█", top)
        else c.put(x, r, "▀", top, { bg: bot })
      } else if (top) c.put(x, r, "▀", top)
      else if (bot) c.put(x, r, "▄", bot)
    }
}
