import type { RGBA } from "@opentui/core"
import { Braille, Quad, type Canvas } from "./canvas.tsx"
import { PERCH, SCENE_ROWS, desert, night, sceneShift, type SceneTime } from "./desert.ts"
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
  /** how wide the scene is drawn, from `sceneCols` */
  cols: number
}

/** From touching to folded and still. */
const FOLD_MS = 330
/** She never breaks off sooner than this after opening, so a fresh open still shows her flying in. */
const MIN_LEAVE_MS = 600
const FLARE_MS = 260

/** Is the flight over (she's folded on the snag), so nothing needs drawing again? */
export const flightDone = (p: FlightPlan) => p.perched || (p.leave != null && p.t >= p.leave + arcMs(p.leave) + FOLD_MS)

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

// ---------------------------------------------------------------- the arc in

/** Her perch, in dots, and where the flare starts: just beyond it and above, so she comes in toward the moon. */
const PERCH_DOTS = { x: PERCH.x * 2 + 1, y: PERCH.y * 2 }
const FLARE_FROM = { x: PERCH_DOTS.x + 2, y: PERCH_DOTS.y - 4 }

/** How far round the loop the blend looks ahead; it shapes the arc, not how long she takes on it. */
const ARC_SHAPE_MS = 940

/** Her speed on the loop, in dots per ms, which she keeps on the way in. */
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

/**
 * The arc as a shape, `u` from breaking off (0) to the flare (1): the circling
 * eases into a curl that swings in front of the snag, round its far side and
 * in over the top.
 */
function arcPoint(leave: number, u: number) {
  const th = 2.6 * (1 - easeInOut(u))
  const shrink = 1 - u ** 1.6
  const curl = { x: FLARE_FROM.x + 16 * shrink * Math.cos(th), y: FLARE_FROM.y + 5 * shrink * Math.sin(th) }
  const lp = loopAt(leave + u * ARC_SHAPE_MS)
  const w = smooth(u / 0.6)
  return { x: lp.x + (curl.x - lp.x) * w, y: lp.y + (curl.y - lp.y) * w }
}

/**
 * When she reaches each point of the arc: at her loop speed, easing off over
 * the last quarter into the flare, so she never speeds up to reach the snag.
 */
const arcs = new Map<number, { ms: number; times: number[] }>()
function arcTiming(leave: number) {
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

/** From breaking off the loop to her talons touching the snag. */
export const arcMs = (leave: number) => arcTiming(leave).ms + FLARE_MS

/** How far along the arc's shape she is `dt` ms after breaking off. */
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
  const land = plan.leave == null ? Infinity : plan.leave + arcMs(plan.leave)
  if (plan.perched || t >= land) {
    const since = plan.perched ? Infinity : t - land
    const pose: LandingPose = since < 140 ? "touch" : since < FOLD_MS ? "fold" : "perch"
    // the branch gives a little under her as she takes it
    const give = since < 200 ? Math.sin((Math.PI * since) / 200) * 2 : 0
    return { x: perch.x, y: perch.y + give, near: 1, pixels: landingPixels(pose, facing), onLoop: false, flying: false }
  }
  const flareAt = land - FLARE_MS
  const f = FLARE_FROM
  if (plan.leave == null || t <= plan.leave) {
    const p = loopAt(t)
    const span = LOOP.far + (LOOP.near - LOOP.far) * p.near
    return { x: p.x, y: p.y, near: p.near, pixels: flyingPixels(span, wingbeat(t)), onLoop: true, flying: true }
  }
  if (t < flareAt) {
    // one continuous arc round the snag, at the speed she kept on the loop
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
const TONES: Record<SceneTime, { near: RGBA; far: RGBA; wing: RGBA; glint: RGBA; trail: RGBA; trailEnd: RGBA; ringEnd: RGBA }> = {
  night: {
    near: brand.papyrus,
    far: brand.dusk,
    wing: hex("#8a6848"),
    glint: brand.gold,
    trail: brand.gold,
    trailEnd: hex("#2f3550"),
    ringEnd: hex("#2a2e44"),
  },
  // backlit against the low sun: pale up in the dark sky, a silhouette against the bright
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
const QUAD_AT = [
  [0, 0, 1],
  [1, 0, 2],
  [0, 1, 4],
  [1, 1, 8],
] as const

/** Braille dot bits in the top two rows of a cell. */
const TOP_DOTS = 0x01 | 0x08 | 0x02 | 0x10
const popcount = (b: number) => {
  let n = 0
  for (; b; b &= b - 1) n++
  return n
}

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

/** Paint the desert and Senu for the plan into a `plan.cols × SCENE_ROWS` canvas. */
export function paintSky(c: Canvas, plan: FlightPlan) {
  const { t, cols } = plan
  const scene = desert(c, { t, busy: plan.busy, time: plan.time, cols })
  const tone = TONES[plan.time]
  // she goes dark over anything bright: by day that's only the sun (the whole
  // sky is bright, so she's dark brown there instead); at night, dawn and dusk
  // it's the moon or sun and the bright low sky she's backlit against
  // she flies in the 72-column composition; `sx` moves her into a wider scene with it, in dots
  const sx = sceneShift(cols) * 2
  const at = (u: number) => {
    const b = birdAt(u, plan, PERCH_DOTS)
    return { ...b, x: b.x + sx }
  }
  const bird0 = at(t)
  // backlit or not is decided for her whole body (the average sky under her), so she never splits in two in the glow
  let sum = 0
  let n = 0
  for (const [dx, dy] of bird0.pixels) {
    const u = scene.px.get(Math.floor((bird0.x + dx) / 2), Math.round(bird0.y / 2 + dy))
    if (u) (sum += lum(u)), n++
  }
  const backlit = plan.time !== "day" && n > 0 && sum / n > (plan.time === "night" ? 0.55 : 0.5)
  const glare = (x: number, y: number, _under: RGBA) => scene.orbAt(x, y) || backlit
  const back = new Quad(cols, SCENE_ROWS)
  const front = new Quad(cols, SCENE_ROWS)
  const trail = new Braille(cols, SCENE_ROWS)
  const bird = bird0

  if (!plan.perched) {
    // the comet: where she's been, gold at her tail, cooling as she comes in to land
    const cool = plan.leave == null ? 1 : 1 - smooth(phase(t, plan.leave, arcMs(plan.leave)))
    const N = 60
    if (cool > 0)
      for (let k = N; k >= 1; k--) {
        const u = t - k * 22
        if (u < 0) continue
        const p = at(u)
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
        trail.dot(p.x + sx + r * Math.cos(a), p.y + r * Math.sin(a) * 0.55, mix(tone.trail, tone.ringEnd, age / 900), 20)
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
    for (let x = 0; x < cols; x++) {
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
      const fg = tb ? trail.color[r]![x]! : null
      if (tb && top && bot && dist(top, bot) > 64) {
        // an outline (a peak, the sun's rim) splits this cell: flattening it would
        // chip the shape, so the line slips behind it here
        if (top.equals(bot)) c.put(x, r, "█", top)
        else c.put(x, r, "▀", top, { bg: bot })
      } else if (tb && top && bot) {
        // a cell holds two scene pixels but only one background: give it to the
        // half the dots leave bare, so the flattened half is the one under them
        const nt = popcount(tb & TOP_DOTS)
        const k = nt / popcount(tb)
        c.put(x, r, String.fromCharCode(0x2800 + tb), fg!, { bg: mix(top, bot, k) })
      } else if (tb) c.put(x, r, String.fromCharCode(0x2800 + tb), fg!, ground ? { bg: ground } : {})
      else if (top && bot) {
        const star = scene.glyphs.find((g) => g.x === x && g.row === r)
        if (star) c.put(x, r, star.ch, star.fg, { bg: mix(top, bot, 0.5) })
        else if (top.equals(bot)) c.put(x, r, "█", top)
        else c.put(x, r, "▀", top, { bg: bot })
      } else if (top) c.put(x, r, "▀", top)
      else if (bot) c.put(x, r, "▄", bot)
    }
}
