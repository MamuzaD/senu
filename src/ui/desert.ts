import { RGBA } from "@opentui/core"
import { Pixels, type Canvas } from "./canvas.tsx"
import { clamp, smooth } from "./motion.ts"
import { brand, hex, mix } from "./theme.ts"

/**
 * Giza behind the usage popup, at night, dawn, day or dusk, in one composition:
 * three pyramids on the far dunes lit from the moon's (or sun's) side, three
 * dune bands, a Medjay campfire on the left, a lightning-struck snag on the
 * right for Senu to perch on, and the moon or sun low on the horizon between
 * them. By night the sky is the terminal's own and the stars are glyphs. The
 * other three paint the sky: dawn goes indigo through rose to pale gold with
 * the sun just rising and the fire down to embers; day is hot haze with the
 * sun where the moon was; dusk burns orange and magenta into purple with the
 * sun sinking through haze and the fire freshly lit. Nothing in it
 * belongs to a profile, so it looks the same however many profiles there
 * are. Painted into pixels, so Senu can be layered through it.
 *
 * It's composed at 72 columns. A wider popup keeps it in the middle and runs
 * the sky, dunes and stars on out to both edges; nothing in it moves.
 */
export const SCENE_COLS = 72
export const SCENE_ROWS = 11

/** How wide the scene is drawn in a terminal `width` columns wide. */
export const sceneCols = (width: number) => Math.max(SCENE_COLS, width)

/** How far a scene `cols` wide moves the 72-column composition in from the left. */
export const sceneShift = (cols: number) => Math.floor((cols - SCENE_COLS) / 2)

/** Stars across a scene `cols` wide: the 72-column pattern, shifted and repeated out to both edges. */
function tile(stars: [number, number, string][], cols: number) {
  const n = Math.ceil(sceneShift(cols) / SCENE_COLS)
  const at = Array.from({ length: 2 * n + 1 }, (_, i) => (i - n) * SCENE_COLS + sceneShift(cols))
  return stars.flatMap(([x, y, ch]) => at.map((k): [number, number, string] => [x + k, y, ch])).filter(([x]) => x >= 0 && x < cols)
}

export type SceneTime = "night" | "dawn" | "day" | "dusk"

export const night = hex("#1a1b26")

/** The moon by night, the sun by day: the same spot, the same size (dawn and dusk sit it lower). */
const ORB = { x: 56, y: 8, r: 4.8 }
/** centre column and height in pixels, left to right */
const PYRAMIDS = [
  { x: 10, size: 5 },
  { x: 18, size: 7 },
  { x: 25, size: 4 },
]
const FIRE = 8

const STARS: [number, number, string][] = [
  [3, 1, "·"], [9, 4, "✦"], [15, 0, "·"], [21, 2, "·"], [27, 5, "⋆"], [31, 1, "·"], [36, 3, "·"],
  [42, 0, "✦"], [46, 2, "·"], [66, 1, "·"], [69, 4, "⋆"], [62, 6, "·"], [12, 7, "·"], [4, 6, "·"], [39, 6, "·"],
]

/**
 * The snag, lit from the moon or sun on its left: `#` bark, `+` lit bark, `:`
 * a thin limb, `f` its foot on the near dune, `p` where her talons go.
 */
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
  /** the painted sky's stops, zenith to horizon, or null for the terminal's own */
  sky: RGBA[] | null
  /** how far down the orb sits (dawn and dusk sit it low on the horizon) */
  orbY: number
  /** the orb's dim and bright ends, its maria (the moon's) and its glow into the sky (the sun's) */
  orb: [RGBA, RGBA]
  maria: RGBA | null
  glow: RGBA | null
  glowR: number
  /** pyramid faces: toward the light, away from it, and the rim the light catches */
  lit: RGBA
  shade: RGBA
  rim: RGBA | null
  /** crest and base of the far, mid and near dunes */
  dunes: [RGBA, RGBA][]
  bark: Record<string, RGBA>
  /** stars: glyphs on the terminal's sky, or a few faint pixels high on a painted one */
  stars: "glyphs" | "faint" | null
  /** the campfire burning, or down to embers with a wisp of smoke */
  fire: "flame" | "embers"
  smoke: RGBA
}

const NIGHT_BARK = { "#": hex("#2b2430"), "+": hex("#6a5a5c"), ":": hex("#54484f"), f: hex("#2b2430") }

const PALETTES: Record<SceneTime, Palette> = {
  night: {
    sky: null,
    orbY: 8,
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
    // cool and pastel: slate-blue overhead, a thin rose band, pale gold only at the sun; mist in the far dunes
    sky: [hex("#1e2850"), hex("#3e4a7c"), hex("#8c7fa6"), hex("#e3a9a2"), hex("#fbe6bc")],
    orbY: 14,
    orb: [hex("#ffd9a6"), hex("#fff7e2")],
    maria: null,
    glow: hex("#ffe6c0"),
    glowR: 5,
    // the light comes low from the right: soft rose faces, always darker than the sky behind them
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
    // a hot, washed-out blue that goes to white haze at the horizon
    sky: [hex("#6c9ec9"), hex("#dcd9cb")],
    orbY: 8,
    orb: [hex("#ffe9a8"), hex("#fffbea")],
    maria: null,
    glow: hex("#fff3c4"),
    glowR: 5,
    lit: hex("#f2d49a"),
    shade: hex("#a47a4e"),
    rim: null,
    // the far dunes are paler sand in the haze, but still sand, so the pyramids stand on ground; the near ones are hot sand
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
    // purple overhead, through magenta, to a hot orange horizon
    sky: [hex("#2e1f4a"), hex("#6a2c62"), hex("#c24a64"), hex("#f0803e"), hex("#f4b070")],
    orbY: 12,
    orb: [hex("#ff8a3a"), hex("#ffd27a")],
    maria: null,
    glow: hex("#ff9a5a"),
    glowR: 9,
    // the pyramids stand as silhouettes, rimmed in orange on the sun's side
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

/** A few faint stars high on a painted dawn or dusk sky: column, row, glyph. */
const FAINT_STARS: [number, number, string][] = [
  [6, 0, "·"], [21, 1, "·"], [38, 0, "⋆"], [47, 1, "·"], [64, 0, "·"],
]

/** Light added over a colour (screen blend), so a warm glow over indigo brightens it instead of greying it. */
function screen(a: RGBA, b: RGBA, k: number): RGBA {
  const [ar, ag, ab] = a.toInts()
  const [br, bg, bb] = b.toInts()
  const sc = (x: number, y: number) => Math.round(x + (255 - x) * (y / 255) * k)
  return RGBA.fromInts(sc(ar, br), sc(ag, bg), sc(ab, bb))
}

/** A colour at `k` (0..1) along evenly spaced stops. */
function along(stops: RGBA[], k: number): RGBA {
  const at = clamp(k) * (stops.length - 1)
  const i = Math.min(Math.floor(at), stops.length - 2)
  return mix(stops[i]!, stops[i + 1]!, at - i)
}

/** A glyph laid over a painted cell of sky, on that cell's colour. */
export interface Glyph {
  x: number
  row: number
  ch: string
  fg: RGBA
}

export interface Desert {
  px: Pixels
  /** faint stars over a painted sky */
  glyphs: Glyph[]
  /** the moon's or sun's disc, in front of the far dunes */
  orbAt: (x: number, y: number) => boolean
  treeAt: (x: number, y: number) => boolean
  /** where her talons go on the snag, in pixels */
  perch: { x: number; y: number }
}

function locate(map: string[], ch: string) {
  for (let j = 0; j < map.length; j++) {
    const i = map[j]!.indexOf(ch)
    if (i >= 0) return { x: i, y: j }
  }
  return { x: 0, y: 0 }
}

/** The near dune's crest, in scene pixels. */
function near(x: number) {
  const PH = SCENE_ROWS * 2
  return PH * 0.9 + (PH / 24) * (1.3 * Math.sin(x / 8 + 0.3) + 0.3 * Math.sin(x / 3.3 + 1))
}

/** Where she perches on the snag, in scene pixels; the same in every scene. */
export const PERCH = (() => {
  const f = locate(SNAG, "f")
  const p = locate(SNAG, "p")
  return { x: SNAG_X + p.x - f.x, y: Math.round(near(SNAG_X)) + p.y - f.y }
})()

/**
 * Paint the scene. `busy` keeps the stars twinkling, the fire flickering and
 * the smoke drifting; otherwise it's still.
 */
export function desert(c: Canvas, o: { t: number; busy: boolean; time: SceneTime; cols: number }): Desert {
  const { t, busy } = o
  const pal = PALETTES[o.time]
  const PW = o.cols
  const PH = SCENE_ROWS * 2
  // everything below is placed in the 72-column composition, `ox` columns in
  const ox = sceneShift(PW)
  const px = new Pixels(PW, PH)
  const s = PH / 24
  const rolling = (x: number) => PH * 0.7 + s * (1.1 * Math.sin((x - ox) / 13 + 1) + 0.7 * Math.sin((x - ox) / 6.1))
  // each pyramid stands on its own level ground, a pixel below where the dune would
  // roll, so the sand only just covers its base; the dune rolls on again past its corners
  const plateaus = PYRAMIDS.map(({ x, size }) => ({ x: x + ox, size, y: Math.round(rolling(x + ox)) + 1 }))
  const far = (x: number) => {
    let at = { w: 0, y: 0 }
    for (const p of plateaus) {
      const w = 1 - smooth((Math.abs(x - p.x) - p.size - 1) / 3)
      if (w > at.w || (w === at.w && p.y > at.y)) at = { w, y: p.y }
    }
    return rolling(x) + (at.y - rolling(x)) * at.w
  }
  const mid = (x: number) => PH * 0.81 + s * (1.6 * Math.sin((x - ox) / 10 + 2.4) + 0.4 * Math.sin((x - ox) / 4.1))
  const nearAt = (x: number) => near(x - ox)

  const glyphs: Glyph[] = []
  const m = { ...ORB, x: ORB.x + ox, y: pal.orbY }
  const onDisc = (x: number, y: number) => (x - m.x) ** 2 + (y - m.y) ** 2 <= m.r ** 2

  if (pal.sky) {
    // a painted sky, with the sun's heat glowing into it
    const sky = pal.sky
    for (let y = 0; y < PH; y++)
      for (let x = 0; x < PW; x++) {
        // dawn and dusk keep the sky dark where she flies and bright only low down,
        // so she's pale against it up high and a silhouette against the glow
        let col = along(sky, (y / (PH * 0.72)) ** (sky.length > 2 ? 1.6 : 1.4))
        if (pal.glow) {
          const d = Math.sqrt((x - m.x) ** 2 + ((y - m.y) * 1.3) ** 2) - m.r
          if (d < pal.glowR) col = screen(col, pal.glow, 0.6 * (1 - Math.max(0, d) / pal.glowR) ** 1.5)
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
      // soft maria, low contrast and low on the face, so her silhouette up top reads cleanly
      if (pal.maria)
        for (const [mx, my, mr] of [[-3.2, 0.8, 2.1], [2.4, 2.4, 1.9], [-0.8, 4.8, 1.5]] as const)
          if ((x - m.x - mx) ** 2 + (y - m.y - my) ** 2 < mr * mr) col = mix(col, pal.maria, 0.28)
      px.set(x, y, col)
    }

  // the pyramids on the far dunes, their faces toward the light lit
  for (const { x: px0, size } of PYRAMIDS) {
    const x0 = px0 + ox
    const base = Math.round(rolling(x0)) + 1
    for (let j = 0; j <= size; j++)
      for (let k = -j; k <= j; k++)
        px.set(x0 + k, base - size + j, pal.rim && k === j ? pal.rim : k >= 0 ? pal.lit : pal.shade)
  }

  // dunes, far to near; the light catches the crests
  for (let x = 0; x < PW; x++) {
    const tops = [far(x), mid(x), nearAt(x)]
    tops.forEach((top, i) => {
      const [crest, base] = pal.dunes[i]!
      for (let y = Math.round(top); y < PH; y++) px.set(x, y, mix(crest, base, clamp((y - top) / 2.5)))
    })
  }

  // a Medjay campfire on the near dune: flames by night and freshly lit at dusk, embers and a wisp of smoke by dawn and day
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
    // a short wisp that leans off the fire and breaks up, so it never reads as a straight stripe
    for (let k = 1; k <= 3; k++) {
      const sx = fire + Math.round(Math.sin(drift + k * 1.9) * 0.9 - k * 0.4)
      const under = px.get(sx, fy - k)
      if (under) px.set(sx, fy - k, mix(under, pal.smoke, 0.36 - k * 0.09))
    }
  }

  // the snag stands on the near dune
  const foot = Math.round(nearAt(SNAG_X + ox))
  const f = locate(SNAG, "f")
  const tree = new Set<string>()
  SNAG.forEach((row, j) =>
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
