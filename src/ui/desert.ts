import { RGBA } from "@opentui/core"

import { Pixels, type Canvas } from "./canvas.tsx"
import { clamp, smooth } from "./motion.ts"
import { brand, hex, mix } from "./theme.ts"

export const SCENE_COLS = 72
export const SCENE_ROWS = 11

export const sceneCols = (width: number) => Math.max(SCENE_COLS, width)

export const sceneShift = (cols: number) => Math.floor((cols - SCENE_COLS) / 2)

function tile(stars: [number, number, string][], cols: number) {
  const n = Math.ceil(sceneShift(cols) / SCENE_COLS)
  const at = Array.from({ length: 2 * n + 1 }, (_, i) => (i - n) * SCENE_COLS + sceneShift(cols))
  return stars
    .flatMap(([x, y, ch]) => at.map((k): [number, number, string] => [x + k, y, ch]))
    .filter(([x]) => x >= 0 && x < cols)
}

export type SceneTime = "night" | "dawn" | "day" | "dusk"

export const night = hex("#1a1b26")

const ORB_RADIUS = 4.8
const PYRAMIDS = [
  { x: 10, size: 5 },
  { x: 18, size: 7 },
  { x: 25, size: 4 },
]
const FIRE = 8

const STARS: [number, number, string][] = [
  [3, 1, "·"],
  [9, 4, "✦"],
  [15, 0, "·"],
  [21, 2, "·"],
  [27, 5, "⋆"],
  [31, 1, "·"],
  [36, 3, "·"],
  [42, 0, "✦"],
  [46, 2, "·"],
  [66, 1, "·"],
  [69, 4, "⋆"],
  [62, 6, "·"],
  [12, 7, "·"],
  [4, 6, "·"],
  [39, 6, "·"],
]

// Scene pixels: # bark, + lit bark, : twig, f ground anchor, p talon anchor, . empty.
const SNAG = [
  ".....p#:...",
  ".....+#:...",
  ".::..+#....",
  "..::.+#..:.",
  "....:+#..:.",
  ".....+#.:..",
  "......+#...",
  "......+#...",
  "...:..+#...",
  "....:.+#...",
  "......+#...",
  "......+#...",
  "......+#...",
  "....+#f##..",
]
const SNAG_X = 67

interface Palette {
  sky: RGBA[] | null
  orbX: number
  orbY: number
  orb: [RGBA, RGBA]
  maria: RGBA | null
  glow: RGBA | null
  glowR: number
  lit: RGBA
  shade: RGBA
  rim: RGBA | null
  dunes: [RGBA, RGBA][]
  bark: Record<string, RGBA>
  stars: "glyphs" | "faint" | null
  fire: "flame" | "embers"
  smoke: RGBA
}

const NIGHT_BARK = {
  "#": hex("#2b2430"),
  "+": hex("#6a5a5c"),
  ":": hex("#54484f"),
  f: hex("#2b2430"),
}

const PALETTES: Record<SceneTime, Palette> = {
  night: {
    sky: null,
    orbX: 32,
    orbY: 5,
    orb: [hex("#b9a582"), hex("#f4ead0")],
    maria: hex("#a8977a"),
    glow: null,
    glowR: 0,
    lit: hex("#4a4156"),
    shade: hex("#2f2a3d"),
    rim: null,
    dunes: [
      [hex("#4a4160"), hex("#2a2638")],
      [hex("#6b5446"), hex("#3a302f")],
      [hex("#9a7a58"), hex("#4d3d34")],
    ],
    bark: NIGHT_BARK,
    stars: "glyphs",
    fire: "flame",
    smoke: hex("#8d8a86"),
  },
  dawn: {
    sky: [hex("#1e2850"), hex("#3e4a7c"), hex("#8c7fa6"), hex("#e3a9a2"), hex("#fbe6bc")],
    orbX: 16,
    orbY: 11,
    orb: [hex("#ffd9a6"), hex("#fff7e2")],
    maria: null,
    glow: hex("#ffe6c0"),
    glowR: 5,
    lit: hex("#a8788a"),
    shade: hex("#3c3a66"),
    rim: hex("#ffdcb0"),
    dunes: [
      [hex("#cfb0b4"), hex("#9a88a4")],
      [hex("#c49080"), hex("#6a5674")],
      [hex("#dca47e"), hex("#735462")],
    ],
    bark: { "#": hex("#33263a"), "+": hex("#6e4c5e"), ":": hex("#4c3a4e"), f: hex("#33263a") },
    stars: "faint",
    fire: "embers",
    smoke: hex("#c8c0d4"),
  },
  day: {
    sky: [hex("#6c9ec9"), hex("#dcd9cb")],
    orbX: 36,
    orbY: 5,
    orb: [hex("#ffe9a8"), hex("#fffbea")],
    maria: null,
    glow: hex("#fff3c4"),
    glowR: 5,
    lit: hex("#f2d49a"),
    shade: hex("#a47a4e"),
    rim: null,
    dunes: [
      [hex("#e4c898"), hex("#cfae7c")],
      [hex("#e2b878"), hex("#c49660")],
      [hex("#f0cc8c"), hex("#c89a62")],
    ],
    bark: { "#": hex("#76624e"), "+": hex("#c4ac8c"), ":": hex("#96806a"), f: hex("#76624e") },
    stars: null,
    fire: "embers",
    smoke: hex("#f4f0e8"),
  },
  dusk: {
    sky: [hex("#2e1f4a"), hex("#6a2c62"), hex("#c24a64"), hex("#f0803e"), hex("#f4b070")],
    orbX: 62,
    orbY: 14,
    orb: [hex("#ff8a3a"), hex("#ffd27a")],
    maria: null,
    glow: hex("#ff9a5a"),
    glowR: 9,
    lit: hex("#4a2a3e"),
    shade: hex("#2c1a2e"),
    rim: hex("#ffb070"),
    dunes: [
      [hex("#7a3a52"), hex("#3e2440")],
      [hex("#8a4a4a"), hex("#3a2234")],
      [hex("#a8603e"), hex("#40262e")],
    ],
    bark: { "#": hex("#26161e"), "+": hex("#7a3e36"), ":": hex("#3e2430"), f: hex("#26161e") },
    stars: "faint",
    fire: "flame",
    smoke: hex("#6a5060"),
  },
}

const FAINT_STARS: [number, number, string][] = [
  [6, 0, "·"],
  [21, 1, "·"],
  [38, 0, "⋆"],
  [47, 1, "·"],
  [64, 0, "·"],
]

function screen(a: RGBA, b: RGBA, k: number): RGBA {
  const [ar, ag, ab] = a.toInts()
  const [br, bg, bb] = b.toInts()
  const sc = (x: number, y: number) => Math.round(x + (255 - x) * (y / 255) * k)
  return RGBA.fromInts(sc(ar, br), sc(ag, bg), sc(ab, bb))
}

function along(stops: RGBA[], k: number): RGBA {
  const at = clamp(k) * (stops.length - 1)
  const i = Math.min(Math.floor(at), stops.length - 2)
  return mix(stops[i]!, stops[i + 1]!, at - i)
}

/** A glyph painted over a sky cell using that cell's background. */
export interface Glyph {
  x: number
  row: number
  ch: string
  fg: RGBA
}

export interface Desert {
  px: Pixels
  /** Faint stars over the painted sky. */
  glyphs: Glyph[]
  /** Whether a scene pixel lies on the moon or sun disc, in front of the far dunes. */
  orbAt: (x: number, y: number) => boolean
  treeAt: (x: number, y: number) => boolean
  /** Talon position on the snag, in scene pixels. */
  perch: { x: number; y: number }
}

function locate(map: string[], ch: string) {
  for (let j = 0; j < map.length; j++) {
    const i = map[j]!.indexOf(ch)
    if (i >= 0) return { x: i, y: j }
  }
  return { x: 0, y: 0 }
}

function near(x: number) {
  const PH = SCENE_ROWS * 2
  return PH * 0.9 + (PH / 24) * (1.3 * Math.sin(x / 8 + 0.3) + 0.3 * Math.sin(x / 3.3 + 1))
}

/** Snag perch position in scene pixels. */
export const PERCH = (() => {
  const f = locate(SNAG, "f")
  const p = locate(SNAG, "p")
  return { x: SNAG_X + p.x - f.x, y: Math.round(near(SNAG_X)) + p.y - f.y }
})()

/** Paints the scene; `busy` animates stars, fire, and smoke, while idle is still. */
export function desert(
  c: Canvas,
  o: { t: number; busy: boolean; time: SceneTime; cols: number },
): Desert {
  const { t, busy } = o
  const pal = PALETTES[o.time]
  const PW = o.cols
  const PH = SCENE_ROWS * 2
  const ox = sceneShift(PW)
  const px = new Pixels(PW, PH)
  const s = PH / 24
  const rolling = (x: number) =>
    PH * 0.7 + s * (1.1 * Math.sin((x - ox) / 13 + 1) + 0.7 * Math.sin((x - ox) / 6.1))
  const plateaus = PYRAMIDS.map(({ x, size }) => ({
    x: x + ox,
    size,
    y: Math.round(rolling(x + ox)) + 1,
  }))
  const far = (x: number) => {
    let at = { w: 0, y: 0 }
    for (const p of plateaus) {
      const w = 1 - smooth((Math.abs(x - p.x) - p.size - 1) / 3)
      if (w > at.w || (w === at.w && p.y > at.y)) at = { w, y: p.y }
    }
    return rolling(x) + (at.y - rolling(x)) * at.w
  }
  const mid = (x: number) =>
    PH * 0.81 + s * (1.6 * Math.sin((x - ox) / 10 + 2.4) + 0.4 * Math.sin((x - ox) / 4.1))
  const nearAt = (x: number) => near(x - ox)

  const glyphs: Glyph[] = []
  const m = { x: pal.orbX + ox, y: pal.orbY, r: ORB_RADIUS }
  const onDisc = (x: number, y: number) => (x - m.x) ** 2 + (y - m.y) ** 2 <= m.r ** 2

  if (pal.sky) {
    const sky = pal.sky
    for (let y = 0; y < PH; y++)
      for (let x = 0; x < PW; x++) {
        let col = along(sky, (y / (PH * 0.72)) ** (sky.length > 2 ? 1.6 : 1.4))
        if (pal.glow) {
          const d = Math.sqrt((x - m.x) ** 2 + ((y - m.y) * 1.3) ** 2) - m.r
          if (d < pal.glowR)
            col = screen(col, pal.glow, 0.6 * (1 - Math.max(0, d) / pal.glowR) ** 1.5)
        }
        px.set(x, y, col)
      }
    if (pal.stars === "faint")
      for (const [x, row, ch] of tile(FAINT_STARS, PW)) {
        const under = px.get(x, row * 2)!
        const tw = busy ? 0.5 + 0.5 * Math.sin(t / 300 + x * 1.7) : 0.6
        glyphs.push({ x, row, ch, fg: mix(under, brand.papyrus, 0.35 + 0.25 * tw) })
      }
  } else {
    for (const [x, y, ch] of tile(STARS, PW)) {
      const tw = busy ? 0.5 + 0.5 * Math.sin(t / 300 + x * 1.7) : 0.6
      c.put(x, y, ch, mix(hex("#3b3d57"), brand.papyrus, tw * (ch === "·" ? 0.55 : 0.8)))
    }
  }

  for (let y = Math.floor(m.y - m.r - 1); y <= Math.ceil(m.y + m.r + 1); y++)
    for (let x = Math.floor(m.x - m.r - 1); x <= Math.ceil(m.x + m.r + 1); x++) {
      if (!onDisc(x, y)) continue
      const lx = (x - m.x) / m.r
      const ly = (y - m.y) / m.r
      let col = mix(pal.orb[0], pal.orb[1], clamp(0.75 + 0.25 * (lx * 0.6 - ly * 0.8)))
      if (pal.maria)
        for (const [mx, my, mr] of [
          [-3.2, 0.8, 2.1],
          [2.4, 2.4, 1.9],
          [-0.8, 4.8, 1.5],
        ] as const)
          if ((x - m.x - mx) ** 2 + (y - m.y - my) ** 2 < mr * mr) col = mix(col, pal.maria, 0.28)
      px.set(x, y, col)
    }

  for (const { x: px0, size } of PYRAMIDS) {
    const x0 = px0 + ox
    const base = Math.round(rolling(x0)) + 1
    for (let j = 0; j <= size; j++)
      for (let k = -j; k <= j; k++)
        px.set(x0 + k, base - size + j, pal.rim && k === j ? pal.rim : k >= 0 ? pal.lit : pal.shade)
  }

  for (let x = 0; x < PW; x++) {
    const tops = [far(x), mid(x), nearAt(x)]
    tops.forEach((top, i) => {
      const [crest, base] = pal.dunes[i]!
      for (let y = Math.round(top); y < PH; y++)
        px.set(x, y, mix(crest, base, clamp((y - top) / 2.5)))
    })
  }

  const fire = FIRE + ox
  const fy = Math.round(nearAt(fire)) - 1
  if (pal.fire === "flame") {
    const flick = busy ? Math.sin(t / 70) * 0.5 + Math.sin(t / 37) * 0.5 : 0.3
    px.set(fire, fy, mix(brand.ember, brand.gold, 0.5 + flick * 0.5))
    if (flick > -0.2) px.set(fire, fy - 1, mix(brand.ember, hex("#ffdd88"), clamp(flick)))
    px.set(fire - 1, fy, hex("#b5553a"))
    px.set(fire + 1, fy, hex("#b5553a"))
  } else {
    const glow = busy ? 0.5 + 0.5 * Math.sin(t / 240) : 0.4
    px.set(fire, fy, mix(hex("#9a4a2c"), hex("#d8743e"), glow))
    px.set(fire - 1, fy, hex("#7a5a48"))
    px.set(fire + 1, fy, hex("#7a5a48"))
    const drift = busy ? t / 900 : 0
    for (let k = 1; k <= 3; k++) {
      const sx = fire + Math.round(Math.sin(drift + k * 1.9) * 0.9 - k * 0.4)
      const under = px.get(sx, fy - k)
      if (under) px.set(sx, fy - k, mix(under, pal.smoke, 0.36 - k * 0.09))
    }
  }

  const foot = Math.round(nearAt(SNAG_X + ox))
  const f = locate(SNAG, "f")
  const tree = new Set<string>()
  SNAG.forEach((row, j) =>
    // oxlint-disable-next-line typescript/no-misused-spread -- sprite rows are ASCII
    [...row].forEach((ch, i) => {
      const bark = pal.bark[ch]
      if (!bark) return
      const x = SNAG_X + ox + i - f.x
      const y = foot + j - f.y
      px.set(x, y, bark)
      tree.add(`${x},${y}`)
    }),
  )

  return {
    px,
    glyphs,
    orbAt: (x, y) => onDisc(x, y) && y < far(x),
    treeAt: (x, y) => tree.has(`${x},${y}`),
    perch: { x: PERCH.x + ox, y: PERCH.y },
  }
}
