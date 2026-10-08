// Ported from herdr (Apache-2.0), modified. See THIRD_PARTY_NOTICES.md.

/**
 * Manifest regions: the slice of the screen (or the OSC title) a rule looks at.
 * Follows herdr's region selection and fallback behavior: a missing region is
 * `""` for some names and the whole screen for others. Slices keep their
 * trailing newline because rules can anchor on it (`\s*\z`). Offsets use
 * JavaScript string positions, which can differ from Rust byte offsets.
 */

export interface DetectionInput {
  /** The pane's visible screen, one line per row. */
  screen: string
  /** The title the agent set with an OSC sequence; `""` if it never set one. */
  oscTitle: string
  /** OSC 9;4 progress. tmux doesn't expose it, so it's normally `""`. */
  oscProgress?: string
}

/** Rust's `str::trim()`: Unicode White_Space, which (unlike JS `trim`) includes U+0085 and leaves out U+FEFF. */
const trim = (s: string) => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
const trimStart = (s: string) => s.replace(/^\p{White_Space}+/u, "")

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

/**
 * Rust's `str::lines()`: split on `\n` or `\r\n`, no empty line after a final
 * newline. A bare `\r` isn't a line ending, so one at the very end stays.
 */
export function lines(content: string): string[] {
  if (!content) return []
  const out = content.split("\n")
  const last = out.pop()!
  const ls = out.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  if (last !== "") ls.push(last)
  return ls
}

function lineStart(content: string, index: number): number {
  let offset = 0
  for (let i = 0; i < index; i++) {
    const end = content.indexOf("\n", offset)
    if (end < 0) return content.length
    offset = end + 1
  }
  return offset
}

const fromLine = (content: string, index: number) => content.slice(lineStart(content, index))

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
  const s = trim(spec)
  return (
    FIXED.has(s) ||
    count(s, "bottom_lines") !== null ||
    count(s, "bottom_non_empty_lines") !== null ||
    topCount(s) !== null
  )
}

export function region(input: DetectionInput, spec: string): string {
  const s = trim(spec)
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
  return fromLine(c, Math.max(0, ls.length - n))
}

function bottomNonEmptyLines(c: string, n: number): string {
  const ls = lines(c)
  let start = -1
  for (let i = ls.length - 1, seen = 0; i >= 0 && seen < n; i--) {
    if (trim(ls[i]!)) {
      start = i
      seen++
    }
  }
  return start < 0 ? "" : fromLine(c, start)
}

function topNonEmptyLines(c: string, n: number): string {
  const ls = lines(c)
  let end = -1
  for (let i = 0, seen = 0; i < ls.length && seen < n; i++) {
    if (trim(ls[i]!)) {
      end = i
      seen++
    }
  }
  return end < 0 ? "" : c.slice(0, lineStart(c, end + 1))
}

const codexPromptLine = (line: string) => line === "›" || line.startsWith("› ")

const codexBlockMarkerLine = (line: string) => /^[•■✗✓]/u.test(line)

function lastIndexWhere(ls: string[], pred: (l: string) => boolean, end = ls.length): number {
  for (let i = end - 1; i >= 0; i--) if (pred(ls[i]!)) return i
  return -1
}

function currentCodexPromptIndex(ls: string[]): number | null {
  const i = lastIndexWhere(ls, codexPromptLine)
  if (i < 0) return null
  return ls.slice(i + 1).some(codexBlockMarkerLine) ? null : i
}

function afterLastPromptMarker(c: string): string {
  const ls = lines(c)
  const i = lastIndexWhere(ls, codexPromptLine)
  return i < 0 ? c : fromLine(c, i + 1)
}

function beforeCurrentPromptMarker(c: string): string {
  const ls = lines(c)
  const i = currentCodexPromptIndex(ls)
  return i === null ? c : c.slice(0, lineStart(c, i))
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
  return i < 0 ? "" : fromLine(c, i)
}

/** Accepts a line of `─`, or at least three `─` before a label; box corners do not count. */
export function isHorizontalRule(line: string): boolean {
  const t = trim(line)
  if (!t) return false
  let run = 0
  while (t[run] === "─") run++
  if (run === 0) return false
  return !trimStart(t.slice(run)) || run >= 3
}

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
  return c.slice(lineStart(c, top + 1), lineStart(c, end))
}

function abovePromptBox(c: string): string {
  const ls = lines(c)
  const top = promptBoxTop(ls)
  return top === null ? c : c.slice(0, lineStart(c, top))
}

function afterLastHorizontalRule(c: string): string {
  let lastRuleEnd = 0
  let offset = 0
  for (const line of lines(c)) {
    const end = c.indexOf("\n", offset)
    offset = end < 0 ? c.length : end + 1
    if (isHorizontalRule(line)) lastRuleEnd = offset
  }
  return c.slice(lastRuleEnd)
}

function lastNonEmptyLine(c: string): string {
  const ls = lines(c)
  const i = lastIndexWhere(ls, (l) => !!trim(l))
  return i < 0 ? "" : ls[i]!
}
