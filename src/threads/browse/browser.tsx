import { basename } from "node:path"

import { TextAttributes, type MouseEvent, type RGBA } from "@opentui/core"
import { useBindings } from "@opentui/keymap/react"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useMemo, useRef, useState } from "react"

import { kill } from "~/threads/live/actions.ts"
import { PRIORITY, type Attention } from "~/threads/live/collect.ts"
import { runApp } from "~/ui/app.tsx"
import { Canvas, CanvasView } from "~/ui/canvas.tsx"
import { DIVE_MS, paintSenu, rowGlow, type DivePlan } from "~/ui/dive.ts"
import { useFlash, usePoll, useSelectionDone } from "~/ui/hooks.ts"
import { fitHints, useHints, type Hint, type HintBinding } from "~/ui/keys.ts"
import { FPS, now, reducedMotion, useTicker } from "~/ui/motion.ts"
import { brand, colors, hex, icons, mix, noColor, states } from "~/ui/theme.ts"
import { formatDuration } from "~/usage/format.ts"

import { copy } from "../clipboard.ts"
import type { Entry } from "../entries.ts"
import { preview, type Thread, type ToolKind, type Turn } from "../thread.ts"

const REFRESH_MS = 5000
const WATCH_MS = 1000
const PER_ROW = 3
const RULE_ROW = 3
const HEAD_ROWS = RULE_ROW + 1
const PREVIEW_MIN_WIDTH = 90
const LIST_MIN_WIDTH = 36
const MESSAGE_LINES = 6
const WHEEL_LINES = 3

const keysFor = (live: boolean): HintBinding[] => [
  { key: "j", cmd: "move-down", desc: "j/k move" },
  { key: "k", cmd: "move-up" },
  { key: "down", cmd: "move-down" },
  { key: "up", cmd: "move-up" },
  { key: "ctrl+d", cmd: "half-down", desc: "^d/^u page" },
  { key: "ctrl+u", cmd: "half-up" },
  { key: "ctrl+f", cmd: "page-down" },
  { key: "ctrl+b", cmd: "page-up" },
  { key: "shift+h", cmd: "screen-top" },
  { key: "shift+m", cmd: "screen-middle" },
  { key: "shift+l", cmd: "screen-bottom" },
  { key: "g", cmd: "first" },
  { key: "shift+g", cmd: "last" },
  { key: "return", cmd: "open", desc: live ? "⏎ jump" : "⏎ open" },
  { key: "/", cmd: "search", desc: "/ search" },
  { key: "p", cmd: "preview", desc: "p preview" },
  { key: "shift+k", cmd: "preview-older", desc: "K/J scroll" },
  { key: "shift+j", cmd: "preview-newer" },
  { key: "ctrl+y", cmd: "preview-older" },
  { key: "ctrl+e", cmd: "preview-newer" },
  { key: "y", cmd: "copy-id", desc: "y copy" },
  { key: "shift+y", cmd: "copy-path" },
  { key: "x", cmd: "kill", desc: "x kill" },
  { key: "r", cmd: "refresh", desc: "r refresh" },
  { key: "q", cmd: "quit", desc: "q quit" },
  { key: "escape", cmd: "quit" },
  ...Array.from({ length: 10 }, (_, d) => ({ key: String(d), cmd: `count-${d}` })),
]

const BOLD = TextAttributes.BOLD
const faint = hex("#3b3d57")

const STARS: [number, number, string][] = [
  [0.14, 0, "·"],
  [0.31, 1, "·"],
  [0.47, 0, "✦"],
  [0.6, 1, "·"],
  [0.72, 0, "·"],
  [0.83, 1, "⋆"],
]

const keyOf = (e: Entry | undefined) => e?.thread?.sessionId ?? e?.live?.paneId ?? ""
const project = (e: Entry) => (e.cwd ? basename(e.cwd) : "")
const profileName = (e: Entry) => {
  const name = e.thread?.profile.slice(e.agent.length + 1)
  return name === "default" ? "" : name
}

function age(ms: number) {
  const s = (Date.now() - ms) / 1000
  return s < 60 ? "now" : formatDuration(s)
}

export function matches(e: Entry, query: string): boolean {
  const hay = [e.title, project(e), e.thread?.profile ?? "", e.agent].join(" ").toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => hay.includes(token))
}

const byAttention = (a: Entry, b: Entry) =>
  PRIORITY[b.live?.state ?? "idle"] - PRIORITY[a.live?.state ?? "idle"]

export const ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

export function sections(entries: Entry[], at = Date.now()): { label: string; entries: Entry[] }[] {
  const old = (e: Entry) => at - e.updatedMs > ARCHIVE_AFTER_MS
  return [
    { label: "running", entries: entries.filter((e) => e.live).toSorted(byAttention) },
    { label: "recent", entries: entries.filter((e) => !e.live && !old(e)) },
    { label: "archived", entries: entries.filter((e) => !e.live && old(e)) },
  ].filter((s) => s.entries.length)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
const TOOL_WORDS: [ToolKind, (n: number) => string][] = [
  ["read", (n) => `read ${plural(n, "file")}`],
  ["edit", (n) => `changed ${plural(n, "file")}`],
  ["run", (n) => `ran ${plural(n, "command")}`],
  ["search", (n) => `searched ${plural(n, "time")}`],
  ["web", (n) => `fetched ${plural(n, "page")}`],
  ["agent", (n) => plural(n, "agent call")],
  ["other", (n) => plural(n, "other tool")],
]

export function toolSummary(tools: Partial<Record<ToolKind, number>>): string {
  return TOOL_WORDS.flatMap(([kind, say]) => (tools[kind] ? [say(tools[kind])] : [])).join(" · ")
}

export function wrap(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = []
  for (const para of text.split("\n")) {
    let line = ""
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (Bun.stringWidth(next) <= width) line = next
      else {
        if (line) lines.push(line)
        line = Bun.stringWidth(word) > width ? `${word.slice(0, width - 1)}…` : word
      }
      if (lines.length >= maxLines) break
    }
    if (line && lines.length < maxLines) lines.push(line)
    if (lines.length >= maxLines) break
  }
  const more = lines.length >= maxLines && text.length > lines.join(" ").length
  if (more && lines.length) lines[lines.length - 1] = `${lines.at(-1)!.slice(0, width - 1)}…`
  return lines
}

export interface Line {
  text: string
  fg: RGBA
  mark: string
}

export function previewLines(turns: Turn[], width: number): Line[] {
  const lines: Line[] = []
  for (const t of turns) {
    if (lines.length) lines.push({ text: "", fg: colors.dim, mark: "" })
    if ("tools" in t)
      for (const text of wrap(`⚙ ${toolSummary(t.tools)}`, width, 2))
        lines.push({ text, fg: colors.dim, mark: "" })
    else
      wrap(t.text.replaceAll("**", ""), width, MESSAGE_LINES).forEach((text, i) =>
        lines.push({
          text,
          fg: t.fromUser ? brand.papyrus : colors.fg,
          mark: t.fromUser && i === 0 ? ">" : "",
        }),
      )
  }
  return lines
}

export function layout(width: number, showPreview: boolean) {
  const split = showPreview && width >= PREVIEW_MIN_WIDTH
  const listW = split ? Math.max(LIST_MIN_WIDTH, Math.floor(width * 0.35)) : width
  const previewX = split ? listW : -2
  return { split, listW, previewX, previewTextW: width - previewX - 6 }
}

type Row = { kind: "header"; label: string; count: number } | { kind: "entry"; entry: Entry }

interface View {
  rows: Row[]
  sel: Entry | null
  top: number
  width: number
  height: number
  query: string
  searching: boolean
  total: number
  showPreview: boolean
  turns: Turn[] | null
  hiddenBelow: number
  note: string
  count: string
  confirming: Entry | null
  hints: Hint[]
  live: boolean
  scouting: boolean
  senu: DivePlan | null
}

const rowHeight = (r: Row) => (r.kind === "header" ? 2 : PER_ROW)

function paintList(c: Canvas, v: View, x0: number, w: number) {
  const right = x0 + w - 2
  let y = 1
  if (v.live) {
    let x = c.text(x0 + 1, y, "agents", brand.sand, { attrs: BOLD }) + 1
    for (const s of ["blocked", "working", "done", "idle"] as Attention[]) {
      const n = v.rows.filter((r) => r.kind === "entry" && r.entry.live?.state === s).length
      if (!n) continue
      x =
        c.text(x + 1, y, states[s].glyph, states[s].fg, { attrs: states[s].bold ? BOLD : 0 }) +
        (s === "idle" ? 1 : 0)
      x = c.text(x + 1, y, String(n), colors.muted)
    }
    if (!noColor)
      for (const [fx, sy, ch] of STARS) {
        const sx = x0 + Math.round(fx * (w - 10))
        if (sy !== y || sx > x + 1)
          c.put(sx, sy, ch, mix(faint, brand.papyrus, ch === "·" ? 0.25 : 0.45))
      }
  } else {
    let x = c.text(x0 + 1, y, "threads", brand.sand, { attrs: BOLD })
    x = c.text(x + 2, y, String(v.total), colors.muted)
    const running = v.rows.filter((r) => r.kind === "entry" && r.entry.live).length
    if (running) c.text(x + 2, y, `${states.working.glyph} ${running}`, states.working.fg)
  }

  y = 2
  if (v.searching || v.query) {
    let sx = c.text(x0 + 1, y, "/ ", brand.gold, { attrs: BOLD })
    sx = c.text(sx, y, v.query, brand.papyrus, { max: right })
    if (v.searching) c.put(sx, y, "▏", brand.gold)
  }
  for (let i = x0 + 1; i <= right; i++) c.put(i, RULE_ROW, "─", colors.rule)

  y = HEAD_ROWS
  const bottom = v.height - 1
  const glow = v.senu ? rowGlow(v.senu) : { from: Infinity, k: 0 }
  for (let i = v.top; i < v.rows.length && y < bottom; i++) {
    const r = v.rows[i]!
    if (y + rowHeight(r) - 1 > bottom) break
    if (r.kind === "header") {
      const hx = c.text(x0 + 1, y, r.label, colors.muted, { attrs: BOLD })
      c.text(hx + 1, y, String(r.count), colors.dim)
      y += rowHeight(r)
      continue
    }
    const e = r.entry
    const selected = v.sel === e
    const lit = (fg: RGBA, col: number) =>
      selected && col >= glow.from ? mix(fg, brand.gold, glow.k) : fg
    if (selected) for (const dy of [0, 1]) c.put(x0 + 1, y + dy, "▌", brand.gold)
    if (e.live) {
      const st = states[e.live.state]
      c.put(x0 + 3, y, st.glyph, lit(st.fg, x0 + 3), { attrs: st.bold ? BOLD : 0 })
    }
    const when = age(e.updatedMs)
    const whenX = right - when.length + 1
    const titleFg = lit(selected ? brand.papyrus : e.live ? colors.fg : colors.muted, x0 + 5)
    const end = c.text(x0 + 5, y, e.title, titleFg, {
      attrs: selected ? BOLD : 0,
      max: whenX - 1,
    })
    if (end >= whenX - 1 && Bun.stringWidth(e.title) > whenX - 1 - (x0 + 5))
      c.put(whenX - 2, y, "…", titleFg)
    c.text(whenX, y, when, lit(colors.dim, whenX))

    const agentFg = noColor ? colors.fg : e.agent === "codex" ? colors.codex : colors.claude
    let mx = c.text(x0 + 5, y + 1, e.agent === "codex" ? icons.codex : icons.claude, agentFg)
    const profile = profileName(e)
    if (profile) mx = c.text(mx + 1, y + 1, profile, colors.dim, { max: right })
    const proj = project(e)
    if (proj) mx = c.text(mx + 2, y + 1, proj, selected ? brand.sand : colors.muted, { max: right })
    if (e.live) {
      mx = c.text(mx + 2, y + 1, e.live.session, colors.muted, { max: right })
      c.text(mx, y + 1, `:${e.live.windowIndex}`, colors.dim, { max: right })
    }
    y += rowHeight(r)
  }
  if (!v.rows.length) {
    const empty = v.query ? "no threads match" : v.live ? "no agents in sight" : "no threads yet"
    c.text(x0 + 5, HEAD_ROWS, empty, colors.dim)
  }
}

function paintPreview(c: Canvas, v: View, x0: number, w: number) {
  for (let y = 0; y < v.height - 1; y++) c.put(x0, y, "│", colors.rule)
  const left = x0 + 2
  const width = w - 3
  const e = v.sel
  if (!e) return
  c.text(left, 1, e.title, brand.papyrus, { attrs: BOLD, max: left + width })
  const meta = [e.agent, profileName(e), project(e), e.live?.state, age(e.updatedMs)]
    .filter(Boolean)
    .join(" · ")
  c.text(left, 2, meta, colors.dim, { max: left + width })
  for (let i = left; i < left + width; i++) c.put(i, RULE_ROW, "─", colors.rule)

  const top = HEAD_ROWS
  const bottom = v.height - 2
  if (!e.thread) {
    c.text(left, top, "no saved thread yet", colors.dim)
    return
  }
  if (!v.turns) {
    c.text(left, top, "reading…", colors.dim)
    return
  }
  const lines = previewLines(v.turns, width - 3)
  const rows = bottom - top + 1
  const end = lines.length - v.hiddenBelow
  const start = Math.max(0, end - rows)
  lines.slice(start, end).forEach((line, i) => {
    const y = top + i
    if (line.mark) c.text(left, y, line.mark, brand.gold, { attrs: BOLD })
    c.text(left + 2, y, line.text, line.fg, { max: left + width - 1 })
  })
  if (lines.length > rows) {
    const bar = left + width - 1
    const thumb = Math.max(1, Math.round((rows * rows) / lines.length))
    const at = Math.round((start / (lines.length - rows)) * (rows - thumb))
    for (let i = 0; i < rows; i++) {
      const on = i >= at && i < at + thumb
      c.put(bar, top + i, on ? "┃" : "│", on ? brand.sand : colors.rule)
    }
  }
}

function paintListBar(c: Canvas, v: View, x: number) {
  const rows = v.height - HEAD_ROWS - 1
  const heights = v.rows.map(rowHeight)
  const total = heights.reduce((a, b) => a + b, 0)
  if (total <= rows) return
  const above = heights.slice(0, v.top).reduce((a, b) => a + b, 0)
  const thumb = Math.max(1, Math.round((rows * rows) / total))
  const at = Math.round((Math.min(above, total - rows) / (total - rows)) * (rows - thumb))
  for (let i = 0; i < rows; i++) {
    const on = i >= at && i < at + thumb
    c.put(x, HEAD_ROWS + i, on ? "┃" : "│", on ? colors.dim : colors.rule)
  }
}

function paint(v: View): Canvas {
  const c = new Canvas(v.width, v.height)
  const { split, listW, previewX } = layout(v.width, v.showPreview)
  if (!v.showPreview || split) paintList(c, v, 0, listW)
  if (v.showPreview) paintPreview(c, v, previewX, v.width - previewX)
  if (!v.showPreview || split) paintListBar(c, v, split ? listW : v.width - 1)

  const fy = v.height - 1
  if (v.confirming) {
    let kx = c.text(1, fy, "kill this ", colors.bad)
    kx = c.text(kx, fy, v.confirming.agent, colors.bad, { attrs: BOLD })
    const title = v.confirming.title
    const room = v.width - kx - 40
    if (room > 8)
      kx = c.text(
        kx,
        fy,
        ` “${Bun.stringWidth(title) > room ? `${title.slice(0, room - 1)}…` : title}”`,
        colors.bad,
      )
    kx = c.text(kx, fy, "?  ", colors.bad)
    kx = c.text(kx, fy, "y", brand.papyrus, { attrs: BOLD })
    c.text(kx, fy, " kill · any other key keeps it", colors.muted)
  } else if (v.note) c.text(1, fy, v.note, brand.gold)
  else {
    const diving = v.senu?.t != null
    const watch = !v.live
      ? ""
      : diving
        ? "senu dives"
        : v.scouting
          ? "senu scouts live"
          : "senu keeps watch"
    const room = v.width - v.count.length - 4
    const hint = v.searching
      ? "type to filter · ⏎ done · esc clear"
      : fitHints(v.hints, room - watch.length - 2, ["open", "search", "quit"])
    c.text(1, fy, hint, colors.dim)
    if (watch && !v.count && Bun.stringWidth(hint) + watch.length + 2 <= room) {
      const fg = diving ? brand.gold : v.scouting ? brand.dusk : brand.shadow
      c.text(v.width - watch.length - 1, fy, watch, fg)
    }
  }
  if (v.count) c.text(v.width - v.count.length - 2, fy, v.count, brand.gold, { attrs: BOLD })
  if (v.senu && (!v.showPreview || split) && listW >= 30) paintSenu(c, v.senu)
  return c
}

const turnsCache = new Map<string, Turn[]>()

function turnsOf(t: Thread): Turn[] {
  const key = `${t.sessionId}:${t.updatedMs}`
  let turns = turnsCache.get(key)
  if (!turns) {
    try {
      turns = preview(t, 40)
    } catch {
      turns = []
    }
    turnsCache.set(key, turns)
  }
  return turns
}

export type Load = () => Promise<Entry[]>
export type Watch = () => Promise<{ merge: (entries: Entry[]) => Entry[]; scouting: boolean }>

export function Browser({
  initial,
  load,
  watch,
  live: startLive,
  limit = Infinity,
  jump,
  onOpen,
}: {
  initial: Entry[]
  load: Load
  watch: Watch
  live: boolean
  limit?: number
  jump: (e: Entry) => Promise<unknown>
  onOpen: (e: Entry) => void
}) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [entries, setEntries] = useState(initial)
  const live = startLive
  const [scouting, setScouting] = useState(false)
  const [diveAt, setDiveAt] = useState<number | null>(null)
  const divingRef = useRef(false)
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const searchingRef = useRef(false)
  const [showPreview, setShowPreview] = useState(() => !startLive && width >= PREVIEW_MIN_WIDTH)
  const [selKey, setSelKey] = useState(() => keyOf(initial.find((e) => e.live) ?? initial[0]))
  // Keys can arrive before React re-renders; actions read the selection from here, not from render.
  const selKeyRef = useRef(selKey)
  const choose = (key: string) => {
    selKeyRef.current = key
    setSelKey(key)
    setOffset({ key, lines: 0 })
  }
  const [scroll, setScroll] = useState(0)
  const [offset, setOffset] = useState({ key: "", lines: 0 })
  const [confirming, setConfirmingState] = useState<Entry | null>(null)
  const confirmingRef = useRef<Entry | null>(null)
  const setConfirming = (e: Entry | null) => {
    confirmingRef.current = e
    setConfirmingState(e)
  }
  const [pendingCount, setPendingCount] = useState("")
  const countRef = useRef("")
  const addDigit = (d: number) => {
    if (d === 0 && !countRef.current) return
    countRef.current = (countRef.current + d).slice(0, 4)
    setPendingCount(countRef.current)
  }
  const takeCount = () => {
    const n = Number(countRef.current)
    countRef.current = ""
    setPendingCount("")
    return n
  }
  const refresh = usePoll(async () => setEntries(await load()), REFRESH_MS)
  const watchNow = usePoll(async () => {
    const seen = await watch()
    setEntries((es) => seen.merge(es))
    setScouting(seen.scouting)
  }, WATCH_MS)

  const shown = useMemo(() => {
    const pool = (live ? entries.filter((e) => e.live).toSorted(byAttention) : entries)
      .slice(0, limit)
      .filter((e) => matches(e, query))
    return live ? [{ label: "running", entries: pool }] : sections(pool)
  }, [entries, query, live, limit])
  const flat = useMemo(() => shown.flatMap((s) => s.entries), [shown])
  const selIndex = Math.max(
    0,
    flat.findIndex((e) => keyOf(e) === selKey),
  )
  const sel = flat[selIndex] ?? null
  const rows: Row[] = []
  for (const s of shown) {
    if (!live) rows.push({ kind: "header", label: s.label, count: s.entries.length })
    const open = s.label !== "archived" || !!query || (sel !== null && s.entries.includes(sel))
    for (const entry of s.entries) if (open) rows.push({ kind: "entry", entry })
  }
  const selRow = rows.findIndex((r) => r.kind === "entry" && r.entry === sel)

  const fits = (from: number, to: number) => {
    let h = 0
    for (let i = from; i <= to; i++) h += rowHeight(rows[i]!)
    return h <= height - HEAD_ROWS - 1
  }
  let top = Math.min(scroll, Math.max(0, selRow - 1))
  while (top < selRow && !fits(top, selRow)) top++
  if (top !== scroll) setScroll(top)

  const selThread = sel?.thread ?? null
  const turns = selThread ? turnsOf(selThread) : null
  const { previewTextW } = layout(width, showPreview)
  const previewRows = height - HEAD_ROWS - 1
  const maxOffset = turns ? Math.max(0, previewLines(turns, previewTextW).length - previewRows) : 0
  const lines = offset.key === selKey ? Math.min(offset.lines, maxOffset) : 0
  const scrollPreview = (by: number) =>
    setOffset((o) => {
      const key = selKeyRef.current
      const from = o.key === key ? Math.min(o.lines, maxOffset) : 0
      return { key, lines: Math.max(0, Math.min(from + by, maxOffset)) }
    })
  const [note, flash] = useFlash()
  const copyOut = (text: string | undefined, what: string) => {
    if (!text) return flash("no saved thread yet")
    void copy(text).then((ok) => flash(ok ? `copied ${what}` : "couldn't reach the clipboard"))
  }
  const [selecting, setSelecting] = useState<"list" | "preview" | null>(null)
  useSelectionDone((text) => {
    setSelecting(null)
    if (text)
      void copy(text).then((ok) => flash(ok ? "copied selection" : "couldn't reach the clipboard"))
  })

  const select = (i: number) => {
    const e = flat[Math.max(0, Math.min(i, flat.length - 1))]
    if (e) choose(keyOf(e))
  }
  const screen: Entry[] = []
  for (let i = top, h = 0; i < rows.length; i++) {
    h += rowHeight(rows[i]!)
    if (h > height - HEAD_ROWS - 1) break
    const r = rows[i]!
    if (r.kind === "entry") screen.push(r.entry)
  }
  const page = Math.max(1, screen.length)
  const selectEntry = (e: Entry | undefined) => e && choose(keyOf(e))
  const current = () => {
    const i = Math.max(
      0,
      flat.findIndex((e) => keyOf(e) === selKeyRef.current),
    )
    return { i, e: flat[i] ?? null }
  }
  const close = () => renderer.destroy()

  const { split, listW } = layout(width, showPreview)
  const listShown = !showPreview || split
  const go = (e: Entry) => {
    divingRef.current = true
    const jumped = jump(e)
    if (reducedMotion || noColor || !listShown || listW < 30) return void jumped.finally(close)
    setDiveAt(now())
    void Promise.all([jumped, Bun.sleep(DIVE_MS)]).finally(close)
  }
  useTicker(diveAt == null ? 0 : FPS)
  let selY = HEAD_ROWS
  for (let i = top; i < selRow; i++) selY += rowHeight(rows[i]!)
  const senu: DivePlan | null = !noColor
    ? {
        t: diveAt == null ? null : now() - diveAt,
        perch: { x: listW - 5, y: RULE_ROW },
        target: { x: 3, y: selY },
      }
    : null

  useKeyboard((key) => {
    if (divingRef.current) return
    const pending = confirmingRef.current
    if (pending) {
      setConfirming(null)
      if ((key.name === "y" || key.name === "x") && pending.live)
        void kill(pending.live).then(() => Promise.all([watchNow(), refresh()]))
      return
    }
    if (!searchingRef.current) return
    if (key.name === "escape") {
      setQuery("")
      setSearching((searchingRef.current = false))
    } else if (key.name === "return") setSearching((searchingRef.current = false))
    else if (key.name === "backspace") setQuery((q) => q.slice(0, -1))
    else if (key.sequence && key.sequence.length === 1 && !key.ctrl && key.sequence >= " ")
      setQuery((q) => q + key.sequence)
  })

  useBindings(
    () => ({
      enabled: () => !searchingRef.current && !confirmingRef.current && !divingRef.current,
      bindings: keysFor(live),
      commands: [
        { name: "quit", run: (n: number) => (n ? undefined : close()) },
        { name: "move-down", run: (n: number) => select(current().i + (n || 1)) },
        { name: "move-up", run: (n: number) => select(current().i - (n || 1)) },
        { name: "first", run: () => select(0) },
        { name: "last", run: (n: number) => select(n ? n - 1 : flat.length - 1) },
        { name: "search", run: () => setSearching((searchingRef.current = true)) },
        { name: "preview", run: () => setShowPreview((s) => !s) },
        { name: "refresh", run: () => void Promise.all([watchNow(), refresh()]) },
        { name: "preview-older", run: (n: number) => scrollPreview(n || 1) },
        { name: "preview-newer", run: (n: number) => scrollPreview(-(n || 1)) },
        { name: "copy-id", run: () => copyOut(current().e?.thread?.sessionId, "session id") },
        {
          name: "copy-path",
          run: () => copyOut(current().e?.thread?.transcript, "transcript path"),
        },
        {
          name: "kill",
          run: () => {
            const { e } = current()
            if (e?.live) setConfirming(e)
            else flash("not running")
          },
        },
        {
          name: "open",
          run: () => {
            const { e } = current()
            if (!e) return
            if (live && e.live) return go(e)
            onOpen(e)
            close()
          },
        },
        {
          name: "half-down",
          run: (n: number) => select(current().i + (n || 1) * Math.ceil(page / 2)),
        },
        {
          name: "half-up",
          run: (n: number) => select(current().i - (n || 1) * Math.ceil(page / 2)),
        },
        { name: "page-down", run: (n: number) => select(current().i + (n || 1) * page) },
        { name: "page-up", run: (n: number) => select(current().i - (n || 1) * page) },
        {
          name: "screen-top",
          run: (n: number) => selectEntry(screen[Math.min(n || 1, screen.length) - 1]),
        },
        {
          name: "screen-middle",
          run: () => selectEntry(screen[Math.floor((screen.length - 1) / 2)]),
        },
        {
          name: "screen-bottom",
          run: (n: number) => selectEntry(screen.at(-Math.min(n || 1, screen.length))),
        },
      ]
        .map((cmd) => ({ name: cmd.name, run: () => cmd.run(takeCount()) }))
        .concat(
          Array.from({ length: 10 }, (_, d) => ({ name: `count-${d}`, run: () => addDigit(d) })),
        ),
    }),
    [flat, top, page, maxOffset, live, width, showPreview],
  )

  const canvas = paint({
    rows,
    sel,
    top,
    width,
    height,
    query,
    searching,
    total: entries.length,
    showPreview,
    turns,
    hiddenBelow: lines,
    note,
    confirming,
    count: pendingCount,
    hints: useHints(),
    live,
    scouting,
    senu,
  })
  const onWheel = (event: MouseEvent) => {
    if (searchingRef.current || confirmingRef.current || divingRef.current) return
    const up = event.scroll?.direction === "up"
    if (showPreview && (!split || event.x >= listW)) scrollPreview(up ? WHEEL_LINES : -WHEEL_LINES)
    else select(current().i + (up ? -1 : 1))
  }
  // Each pane is its own selectable view; a drag that starts in one turns the other off, since
  // OpenTUI widens a selection past the view it started in but only ever picks up selectable text.
  const bodyH = height - 1
  const listCols = showPreview ? (split ? listW : 0) : width - 1
  const previewFrom = split ? listW + 1 : 0
  return (
    <box width={width} height={height} flexDirection="column" onMouseScroll={onWheel}>
      <box flexDirection="row" height={bodyH}>
        {listCols > 0 && (
          <box width={listCols} onMouseDown={() => setSelecting("list")}>
            <CanvasView
              canvas={canvas.region(0, 0, listCols, bodyH)}
              selectable={selecting !== "preview"}
            />
          </box>
        )}
        {listCols > 0 && (
          <box width={1}>
            <CanvasView canvas={canvas.region(listCols, 0, 1, bodyH)} />
          </box>
        )}
        {showPreview && (
          <box width={width - previewFrom - 2} onMouseDown={() => setSelecting("preview")}>
            <CanvasView
              canvas={canvas.region(previewFrom, 0, width - previewFrom - 2, bodyH)}
              selectable={selecting !== "list"}
            />
          </box>
        )}
        {showPreview && (
          <box width={2}>
            <CanvasView canvas={canvas.region(width - 2, 0, 2, bodyH)} />
          </box>
        )}
      </box>
      <CanvasView canvas={canvas.region(0, bodyH, width, 1)} />
    </box>
  )
}

/** Resolves with the entry to open, or null when the browser was quit or already jumped to an agent. */
export async function runBrowser(
  initial: Entry[],
  opts: {
    load: Load
    watch: Watch
    live: boolean
    limit?: number
    jump: (e: Entry) => Promise<unknown>
  },
): Promise<Entry | null> {
  let picked: Entry | null = null
  await runApp(<Browser initial={initial} {...opts} onOpen={(e) => (picked = e)} />, {
    useMouse: true,
  })
  return picked
}
