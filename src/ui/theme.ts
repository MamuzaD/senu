import { RGBA } from "@opentui/core"

// Indexed colours, so they render through the terminal's own 256-colour
// palette exactly like the tmux status bar does.
export const colors = {
  fg: RGBA.defaultForeground(),
  claude: RGBA.fromIndex(208),
  codex: RGBA.fromIndex(39),
  good: RGBA.fromIndex(76),
  warn: RGBA.fromIndex(214),
  bad: RGBA.fromIndex(160),
  dim: RGBA.fromIndex(240),
  muted: RGBA.fromIndex(245),
  rule: RGBA.fromIndex(238),
  eagle: RGBA.fromIndex(179),
  eagleFar: RGBA.fromIndex(137),
}

export const icons = {
  codex: "\u{EC81}", // nerd font cod-openai
  claude: "\u{EC82}", // nerd font cod-claude
}
