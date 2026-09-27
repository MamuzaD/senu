import { RGBA } from "@opentui/core"

/** NO_COLOR (https://no-color.org): any non-empty value turns every colour into the default foreground. */
export const noColor = !!process.env.NO_COLOR

const plain = RGBA.defaultForeground()
const indexed = (i: number) => (noColor ? plain : RGBA.fromIndex(i))
export const hex = (h: string) => (noColor ? plain : RGBA.fromHex(h))

export const colors = {
  fg: plain,
  claude: indexed(208),
  codex: indexed(39),
  good: indexed(76),
  warn: indexed(214),
  bad: indexed(160),
  dim: indexed(240),
  muted: indexed(245),
  rule: indexed(238),
}

export const brand = {
  sand: hex("#d8b27a"),
  gold: hex("#f2c46b"),
  ember: hex("#e0894f"),
  dusk: hex("#8a7a9e"),
  papyrus: hex("#e9dcc0"),
  shadow: hex("#5c5346"),
}

export const states = {
  blocked: { glyph: "!", fg: hex("#ff9e64"), bold: true },
  working: { glyph: "●", fg: hex("#e0c060"), bold: false },
  done: { glyph: noColor ? "✓" : "●", fg: hex("#7aa2f7"), bold: true },
  idle: { glyph: "◯", fg: hex("#9ece6a"), bold: false },
}

export const icons = {
  codex: "\u{EC81}", // Nerd Font cod-openai
  claude: "\u{EC82}", // Nerd Font cod-claude
}

const clamp01 = (k: number) => Math.max(0, Math.min(1, k))

/** Clamps k to 0..1; endpoints return the original color tokens, preserving indexed/default colors. NO_COLOR returns a. */
export function mix(a: RGBA, b: RGBA, k: number): RGBA {
  k = clamp01(k)
  if (noColor || k === 0) return a
  if (k === 1) return b
  const [ar, ag, ab] = a.toInts()
  const [br, bg, bb] = b.toInts()
  return RGBA.fromInts(
    Math.round(ar + (br - ar) * k),
    Math.round(ag + (bg - ag) * k),
    Math.round(ab + (bb - ab) * k),
  )
}
