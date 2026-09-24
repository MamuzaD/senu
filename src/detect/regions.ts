/**
 * Manifest regions: the slice of the screen (or the OSC title) a rule looks at.
 * A line-for-line port of herdr's `src/detect/manifest.rs`, down to the edge
 * cases: a region that can't be found is `""` for some names and the whole
 * screen for others, and slices keep their trailing newline, because rules
 * anchor on it (`\s*\z`).
 */

export interface DetectionInput {
  /** The pane's visible screen, one line per row. */
  screen: string
  /** The title the agent set with an OSC sequence; `""` if it never set one. */
  oscTitle: string
  /** OSC 9;4 progress. tmux doesn't expose it, so it's normally `""`. */
  oscProgress?: string
}

const FIXED = new Set([
  "whole_recent",
  "after_last_prompt_marker",
  "before_current_prompt_marker",
  "whole_recent_without_current_prompt_marker",
  "current_prompt_block_marker",
  "after_current_prompt_block_marker",
  "prompt_box_body",
  "above_prompt_box",
  "last_non_empty_above_prompt_box",
  "after_last_horizontal_rule",
  "osc_title",
  "osc_progress",
])

/** Rust's `str::lines()`: split on `\n`, drop one `\r` per line, no empty line after a final `\n`. */
export function lines(content: string): string[] {
  if (!content) return []
  const out = content.split("\n")
  if (out[out.length - 1] === "") out.pop()
  return out.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
}

/** Offset where line `index` starts, counting each line plus its newline, clamped to the text. */
function lineStart(content: string, ls: string[], index: number): number {
  let offset = 0
  for (let i = 0; i < Math.min(index, ls.length); i++) offset += ls[i]!.length + 1
  return Math.min(offset, content.length)
}

const fromLine = (content: string, ls: string[], index: number) => content.slice(lineStart(content, ls, index))

const USIZE_MAX = 2n ** 64n - 1n

/** Rust's `str::parse::<usize>()` on what's inside `name(…)`: an optional `+`, digits, no overflow. */
function count(spec: string, name: string): number | null {
  if (!spec.startsWith(`${name}(`) || !spec.endsWith(")")) return null
  const digits = spec.slice(name.length + 1, -1)
  if (!/^\+?\d+$/.test(digits) || BigInt(digits.replace("+", "")) > USIZE_MAX) return null
  return Number(digits)
}

/** `top_non_empty_lines(n)` is stricter: digits only, no leading zero, and at most u16::MAX. */
function topCount(spec: string): number | null {
  const n = count(spec, "top_non_empty_lines")
  if (n === null || !/^top_non_empty_lines\([1-9]\d*\)$/.test(spec)) return null
  return n <= 0xffff ? n : null
}

export function isValidRegion(spec: string): boolean {
  const s = spec.trim()
  return FIXED.has(s) || count(s, "bottom_lines") !== null || count(s, "bottom_non_empty_lines") !== null || topCount(s) !== null
}

export function region(input: DetectionInput, spec: string): string {
  const s = spec.trim()
  if (s === "osc_title") return input.oscTitle
  if (s === "osc_progress") return input.oscProgress ?? ""

  const c = input.screen
  switch (s) {
    case "whole_recent":
      return c
    case "after_last_prompt_marker":
      return afterLastPromptMarker(c)
    case "before_current_prompt_marker":
      return beforeCurrentPromptMarker(c)
    case "whole_recent_without_current_prompt_marker":
      return currentCodexPromptIndex(lines(c)) === null ? c : ""
    case "current_prompt_block_marker":
      return currentPromptBlockMarker(c)
    case "after_current_prompt_block_marker":
      return afterCurrentPromptBlockMarker(c)
    case "prompt_box_body":
      return promptBoxBody(c)
    case "above_prompt_box":
      return abovePromptBox(c)
    case "last_non_empty_above_prompt_box":
      return lastNonEmptyLine(abovePromptBox(c))
    case "after_last_horizontal_rule":
      return afterLastHorizontalRule(c)
  }

  let n = count(s, "bottom_lines")
  if (n !== null) return bottomLines(c, n)
  n = count(s, "bottom_non_empty_lines")
  if (n !== null) return bottomNonEmptyLines(c, n)
  n = topCount(s)
  if (n !== null) return topNonEmptyLines(c, n)
  return ""
}

function bottomLines(c: string, n: number): string {
  const ls = lines(c)
  return fromLine(c, ls, Math.max(0, ls.length - n))
}

function bottomNonEmptyLines(c: string, n: number): string {
  const ls = lines(c)
  let start = -1
  for (let i = ls.length - 1, seen = 0; i >= 0 && seen < n; i--) {
    if (ls[i]!.trim()) {
      start = i
      seen++
    }
  }
  return start < 0 ? "" : fromLine(c, ls, start)
}

function topNonEmptyLines(c: string, n: number): string {
  const ls = lines(c)
  let end = -1
  for (let i = 0, seen = 0; i < ls.length && seen < n; i++) {
    if (ls[i]!.trim()) {
      end = i
      seen++
    }
  }
  return end < 0 ? "" : c.slice(0, lineStart(c, ls, end + 1))
}

/** Codex's composer line: a bare `›`, or `› ` and a draft, at column zero. */
const codexPromptLine = (line: string) => line === "›" || line.startsWith("› ")

/** Codex starts each transcript block (response, tool call, error, result) with one of these. */
const codexBlockMarkerLine = (line: string) => /^[•■✗✓]/u.test(line)

function lastIndexWhere(ls: string[], pred: (l: string) => boolean, end = ls.length): number {
  for (let i = end - 1; i >= 0; i--) if (pred(ls[i]!)) return i
  return -1
}

/** The last prompt line, unless a block started after it, which makes it stale. */
function currentCodexPromptIndex(ls: string[]): number | null {
  const i = lastIndexWhere(ls, codexPromptLine)
  if (i < 0) return null
  return ls.slice(i + 1).some(codexBlockMarkerLine) ? null : i
}

function afterLastPromptMarker(c: string): string {
  const ls = lines(c)
  const i = lastIndexWhere(ls, codexPromptLine)
  return i < 0 ? c : fromLine(c, ls, i + 1)
}

function beforeCurrentPromptMarker(c: string): string {
  const ls = lines(c)
  const i = currentCodexPromptIndex(ls)
  return i === null ? c : c.slice(0, lineStart(c, ls, i))
}

function currentPromptBlockMarker(c: string): string {
  const ls = lines(c)
  const prompt = currentCodexPromptIndex(ls)
  if (prompt === null) return ""
  const i = lastIndexWhere(ls, codexBlockMarkerLine, prompt)
  return i < 0 ? "" : ls[i]!
}

function afterCurrentPromptBlockMarker(c: string): string {
  const ls = lines(c)
  const prompt = currentCodexPromptIndex(ls)
  if (prompt === null) return ""
  const i = lastIndexWhere(ls, codexBlockMarkerLine, prompt)
  return i < 0 ? "" : fromLine(c, ls, i)
}

/**
 * A trimmed line that starts with `─`: all rule, or at least three `─` then a
 * label (Claude titles some rules). Box corners like `╭` don't count.
 */
export function isHorizontalRule(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  let run = 0
  while (t[run] === "─") run++
  if (run === 0) return false
  return !t.slice(run).trimStart() || run >= 3
}

/** The prompt box is the last two rules; its top is the second-to-last rule on screen. */
function promptBoxTop(ls: string[]): number | null {
  let seen = 0
  for (let i = ls.length - 1; i >= 0; i--) {
    if (isHorizontalRule(ls[i]!) && ++seen === 2) return i
  }
  return null
}

function promptBoxBody(c: string): string {
  const ls = lines(c)
  const top = promptBoxTop(ls)
  if (top === null) return ""
  const rel = ls.slice(top + 1).findIndex(isHorizontalRule)
  const end = rel < 0 ? ls.length : top + 1 + rel
  return c.slice(lineStart(c, ls, top + 1), lineStart(c, ls, end))
}

function abovePromptBox(c: string): string {
  const ls = lines(c)
  const top = promptBoxTop(ls)
  return top === null ? c : c.slice(0, lineStart(c, ls, top))
}

function afterLastHorizontalRule(c: string): string {
  let lastRuleEnd = 0
  let offset = 0
  for (const line of lines(c)) {
    const next = offset + line.length + 1
    if (isHorizontalRule(line)) lastRuleEnd = Math.min(next, c.length)
    offset = next
  }
  return c.slice(lastRuleEnd)
}

function lastNonEmptyLine(c: string): string {
  const ls = lines(c)
  const i = lastIndexWhere(ls, (l) => !!l.trim())
  return i < 0 ? "" : ls[i]!
}
