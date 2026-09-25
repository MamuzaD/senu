import { RGBA } from "@opentui/core"

/** NO_COLOR (https://no-color.org): any non-empty value turns every colour into the default foreground. */
export const noColor = !!process.env.NO_COLOR

const plain = RGBA.defaultForeground()
const indexed = (i: number) => (noColor ? plain : RGBA.fromIndex(i))
export const hex = (h: string) => (noColor ? plain : RGBA.fromHex(h))

// Semantic colours stay indexed, so they render through the terminal's own
// 256-colour palette exactly like the tmux status bar does.
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

// The brand layer (Senu, the desert, Eagle Vision) is truecolor: dusk over the desert.
export const brand = {
  sand: hex("#d8b27a"),
  gold: hex("#f2c46b"),
  ember: hex("#e0894f"),
  dusk: hex("#8a7a9e"),
  papyrus: hex("#e9dcc0"),
  shadow: hex("#5c5346"),
}

/** The agent states exactly as the tmux status bar draws them (`window-status-format`). */
export const states = {
  blocked: { glyph: "!", fg: hex("#ff9e64"), bold: true },
  working: { glyph: "●", fg: hex("#e0c060"), bold: false },
  // without colour, done and working would both be ●
  done: { glyph: noColor ? "✓" : "●", fg: hex("#7aa2f7"), bold: true },
  idle: { glyph: "◯", fg: hex("#9ece6a"), bold: false },
}

export const icons = {
  codex: "\u{EC81}", // nerd font cod-openai
  claude: "\u{EC82}", // nerd font cod-claude
}

const clamp01 = (k: number) => Math.max(0, Math.min(1, k))

/**
 * Blend from `a` (k=0) to `b` (k=1). The ends come back as the tokens
 * themselves, so an eased-out indexed colour lands on the real palette entry
 * rather than a truecolor lookalike.
 */
export function mix(a: RGBA, b: RGBA, k: number): RGBA {
  k = clamp01(k)
  if (noColor || k === 0) return a
  if (k === 1) return b
  const [ar, ag, ab] = a.toInts()
  const [br, bg, bb] = b.toInts()
  return RGBA.fromInts(Math.round(ar + (br - ar) * k), Math.round(ag + (bg - ag) * k), Math.round(ab + (bb - ab) * k))
}
