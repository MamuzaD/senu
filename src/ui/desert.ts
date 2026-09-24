import type { RGBA } from "@opentui/core"
import { Pixels, type Canvas } from "./canvas.tsx"
import { clamp } from "./motion.ts"
import { brand, hex, mix } from "./theme.ts"

/**
 * Giza behind the usage popup, by night or by day, in one composition:
 * three pyramids on the far dunes lit from the moon's (or sun's) side, three
 * dune bands, a Medjay campfire on the left, a lightning-struck snag on the
 * right for Senu to perch on, and the moon or sun low on the horizon between
 * them. By night the sky is the terminal's own and the stars are glyphs; by
 * day the sky is a painted panel of hot haze, the sun burns where the moon
 * was and the fire is down to embers and a wisp of smoke. Nothing in it
 * belongs to a profile, so it looks the same however many profiles there
 * are. Painted into pixels, so Senu can be layered through it.
 */
export const SCENE_COLS = 72
export const SCENE_ROWS = 11

export type SceneTime = "night" | "day"

export const night = hex("#1a1b26")

/** The moon by night, the sun by day: the same spot, the same size. */
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
  ".....p.:...",
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
  /** the painted sky, zenith to horizon, or null for the terminal's own */
  sky: [RGBA, RGBA] | null
  /** the orb's dim and bright ends, its maria (the moon's) and its glow into the sky (the sun's) */
  orb: [RGBA, RGBA]
  maria: RGBA | null
  glow: RGBA | null
  /** pyramid faces: toward the light, away from it */
  lit: RGBA
  shade: RGBA
  /** crest and base of the far, mid and near dunes */
  dunes: [RGBA, RGBA][]
  bark: Record<string, RGBA>
}

const PALETTES: Record<SceneTime, Palette> = {
  night: {
    sky: null,
    orb: [hex("#b9a582"), hex("#f4ead0")],
    maria: hex("#a8977a"),
    glow: null,
    lit: hex("#4a4156"),
    shade: hex("#2f2a3d"),
    dunes: [
      [hex("#4a4160"), hex("#2a2638")],
      [hex("#6b5446"), hex("#3a302f")],
      [hex("#9a7a58"), hex("#4d3d34")],
    ],
    bark: { "#": hex("#2b2430"), "+": hex("#6a5a5c"), ":": hex("#54484f"), f: hex("#2b2430") },
  },
  day: {
    // a hot, washed-out blue that goes to white haze at the horizon
    sky: [hex("#7fb0d6"), hex("#e6e2d2")],
    orb: [hex("#ffe9a8"), hex("#fffbea")],
    maria: null,
    glow: hex("#fff3c4"),
    lit: hex("#f2d49a"),
    shade: hex("#a47a4e"),
    // the far dunes fade into the haze; the near ones are hot sand
    dunes: [
      [hex("#d9d0ba"), hex("#c7b598")],
      [hex("#e2b878"), hex("#c49660")],
      [hex("#f0cc8c"), hex("#c89a62")],
    ],
    bark: { "#": hex("#5a4232"), "+": hex("#a07e5a"), ":": hex("#7a5e48"), f: hex("#5a4232") },
  },
}

export interface Desert {
  px: Pixels
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

/**
 * Paint the scene. `busy` keeps the stars twinkling, the fire flickering and
 * the smoke drifting; otherwise it's still.
 */
export function desert(c: Canvas, o: { t: number; busy: boolean; time: SceneTime }): Desert {
  const { t, busy, time } = o
  const pal = PALETTES[time]
  const PW = SCENE_COLS
  const PH = SCENE_ROWS * 2
  const px = new Pixels(PW, PH)
  const s = PH / 24
  const far = (x: number) => PH * 0.7 + s * (1.1 * Math.sin(x / 13 + 1) + 0.7 * Math.sin(x / 6.1))
  const mid = (x: number) => PH * 0.81 + s * (1.6 * Math.sin(x / 10 + 2.4) + 0.4 * Math.sin(x / 4.1))
  const near = (x: number) => PH * 0.9 + s * (1.3 * Math.sin(x / 8 + 0.3) + 0.3 * Math.sin(x / 3.3 + 1))

  const m = ORB
  const onDisc = (x: number, y: number) => (x - m.x) ** 2 + (y - m.y) ** 2 <= m.r ** 2

  if (pal.sky) {
    // the day sky, with the sun's heat glowing into it
    const [zenith, haze] = pal.sky
    for (let y = 0; y < PH; y++)
      for (let x = 0; x < PW; x++) {
        let col = mix(zenith, haze, (y / (PH * 0.72)) ** 1.4)
        if (pal.glow) {
          const d = Math.sqrt((x - m.x) ** 2 + (y - m.y) ** 2) - m.r
          if (d < 5) col = mix(col, pal.glow, 0.55 * (1 - Math.max(0, d) / 5) ** 1.5)
        }
        px.set(x, y, col)
      }
  } else {
    for (const [x, y, ch] of STARS) {
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
  for (const { x: x0, size } of PYRAMIDS) {
    const base = Math.round(far(x0)) + 1
    for (let j = 0; j <= size; j++)
      for (let k = -j; k <= j; k++) px.set(x0 + k, base - size + j, k >= 0 ? pal.lit : pal.shade)
  }

  // dunes, far to near; the light catches the crests
  for (let x = 0; x < PW; x++) {
    const tops = [far(x), mid(x), near(x)]
    tops.forEach((top, i) => {
      const [crest, base] = pal.dunes[i]!
      for (let y = Math.round(top); y < PH; y++) px.set(x, y, mix(crest, base, clamp((y - top) / 2.5)))
    })
  }

  // a Medjay campfire on the near dune: flames by night, embers and a wisp of smoke by day
  const fy = Math.round(near(FIRE)) - 1
  if (time === "night") {
    const flick = busy ? Math.sin(t / 70) * 0.5 + Math.sin(t / 37) * 0.5 : 0.3
    px.set(FIRE, fy, mix(brand.ember, brand.gold, 0.5 + flick * 0.5))
    if (flick > -0.2) px.set(FIRE, fy - 1, mix(brand.ember, hex("#ffdd88"), clamp(flick)))
    px.set(FIRE - 1, fy, hex("#b5553a"))
    px.set(FIRE + 1, fy, hex("#b5553a"))
  } else {
    const glow = busy ? 0.5 + 0.5 * Math.sin(t / 240) : 0.4
    px.set(FIRE, fy, mix(hex("#9a4a2c"), hex("#d8743e"), glow))
    px.set(FIRE - 1, fy, hex("#7a5a48"))
    px.set(FIRE + 1, fy, hex("#7a5a48"))
    const drift = busy ? t / 900 : 0
    for (let k = 1; k <= 4; k++) {
      const sx = FIRE + Math.round(Math.sin(drift + k * 0.9) * 0.8 + k * 0.25)
      const under = px.get(sx, fy - k)
      if (under) px.set(sx, fy - k, mix(under, hex("#8d8a86"), 0.5 - k * 0.09))
    }
  }

  // the snag stands on the near dune
  const foot = Math.round(near(SNAG_X))
  const f = locate(SNAG, "f")
  const p = locate(SNAG, "p")
  const tree = new Set<string>()
  SNAG.forEach((row, j) =>
    [...row].forEach((ch, i) => {
      const bark = pal.bark[ch]
      if (!bark) return
      const x = SNAG_X + i - f.x
      const y = foot + j - f.y
      px.set(x, y, bark)
      tree.add(`${x},${y}`)
    }),
  )

  return {
    px,
    orbAt: (x, y) => onDisc(x, y) && y < far(x),
    treeAt: (x, y) => tree.has(`${x},${y}`),
    perch: { x: SNAG_X + p.x - f.x, y: foot + p.y - f.y },
  }
}
