import { basename } from "node:path"

import { TextAttributes, createCliRenderer } from "@opentui/core"
import { type Binding } from "@opentui/keymap"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider, useActiveKeys, useBindings } from "@opentui/keymap/react"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react"

import { kill } from "~/threads/live/actions.ts"
import { Canvas, CanvasView } from "~/ui/canvas.tsx"
import { brand, colors, icons, noColor, states } from "~/ui/theme.ts"
import { UpdateGate, updateGate } from "~/update/gate.tsx"
import { formatDuration } from "~/usage/format.ts"

import { copy } from "../clipboard.ts"
import type { Entry } from "../entries.ts"
import { preview, type Thread, type ToolKind, type Turn } from "../thread.ts"

const REFRESH_MS = 5000
const PER_ROW = 3
const HEAD_ROWS = 3
const PREVIEW_MIN_WIDTH = 90
const LIST_MIN_WIDTH = 36
const MESSAGE_LINES = 6

type BrowserBinding = Binding & { desc?: string }
const browserKeys: BrowserBinding[] = [
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
  { key: "return", cmd: "open", desc: "⏎ open" },
  { key: "/", cmd: "search", desc: "/ search" },
  { key: "p", cmd: "preview", desc: "p preview" },
  { key: "y", cmd: "copy-id", desc: "y copy" },
  { key: "shift+y", cmd: "copy-path" },
  { key: "x", cmd: "kill", desc: "x kill" },
  { key: "r", cmd: "refresh", desc: "r refresh" },
  { key: "q", cmd: "quit", desc: "q quit" },
  { key: "escape", cmd: "quit" },
  ...Array.from({ length: 9 }, (_, i) => ({ key: String(i + 1), cmd: `pick-${i + 1}` })),
]

const BOLD = TextAttributes.BOLD

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

export const ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

export function sections(
  entries: Entry[],
  now = Date.now(),
): { label: string; entries: Entry[] }[] {
  const old = (e: Entry) => now - e.updatedMs > ARCHIVE_AFTER_MS
  return [
    { label: "running", entries: entries.filter((e) => e.live) },
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

type Row =
  | { kind: "header"; label: string; count: number }
  | { kind: "entry"; entry: Entry; n: number }

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
  note: string
  confirming: Entry | null
  hints: { command: string; desc: string }[]
}

const rowHeight = (r: Row) => (r.kind === "header" ? 2 : PER_ROW)

function paintList(c: Canvas, v: View, x0: number, w: number) {
  const right = x0 + w - 2
  let y = 0
  let x = c.text(x0 + 1, y, "threads", brand.sand, { attrs: BOLD })
  x = c.text(x + 2, y, String(v.total), colors.muted)
  const running = v.rows.filter((r) => r.kind === "entry" && r.entry.live).length
  if (running) c.text(x + 2, y, `${states.working.glyph} ${running}`, states.working.fg)

  y = 1
  if (v.searching || v.query) {
    let sx = c.text(x0 + 1, y, "/ ", brand.gold, { attrs: BOLD })
    sx = c.text(sx, y, v.query, brand.papyrus, { max: right })
    if (v.searching) c.put(sx, y, "▏", brand.gold)
  }
  for (let i = x0 + 1; i <= right; i++) c.put(i, 2, "─", colors.rule)

  y = HEAD_ROWS
  const bottom = v.height - 1
  let onScreen = 0
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
    if (selected) for (const dy of [0, 1]) c.put(x0 + 1, y + dy, "▌", brand.gold)
    if (++onScreen <= 9) c.text(x0 + 2, y + 1, String(onScreen), colors.dim)
    if (e.live) {
      const st = states[e.live.state]
      c.put(x0 + 3, y, st.glyph, st.fg, { attrs: st.bold ? BOLD : 0 })
    }
    const when = age(e.updatedMs)
    const whenX = right - when.length + 1
    const titleFg = selected ? brand.papyrus : e.live ? colors.fg : colors.muted
    const end = c.text(x0 + 5, y, e.title, titleFg, {
      attrs: selected ? BOLD : 0,
      max: whenX - 1,
    })
    if (end >= whenX - 1 && Bun.stringWidth(e.title) > whenX - 1 - (x0 + 5))
      c.put(whenX - 2, y, "…", titleFg)
    c.text(whenX, y, when, colors.dim)

    const agentFg = noColor ? colors.fg : e.agent === "codex" ? colors.codex : colors.claude
    let mx = c.text(x0 + 5, y + 1, e.agent === "codex" ? icons.codex : icons.claude, agentFg)
    const profile = profileName(e)
    if (profile) mx = c.text(mx + 1, y + 1, profile, colors.dim, { max: right })
    const proj = project(e)
    if (proj) c.text(mx + 2, y + 1, proj, selected ? brand.sand : colors.muted, { max: right })
    y += rowHeight(r)
  }
  if (!v.rows.length)
    c.text(x0 + 5, HEAD_ROWS, v.query ? "no threads match" : "no threads yet", colors.dim)
}

function paintPreview(c: Canvas, v: View, x0: number, w: number) {
  for (let y = 0; y < v.height - 1; y++) c.put(x0, y, "│", colors.rule)
  const left = x0 + 2
  const width = w - 3
  const e = v.sel
  if (!e) return
  c.text(left, 0, e.title, brand.papyrus, { attrs: BOLD, max: left + width })
  const meta = [e.agent, profileName(e), project(e), e.live?.state, age(e.updatedMs)]
    .filter(Boolean)
    .join(" · ")
  c.text(left, 1, meta, colors.dim, { max: left + width })
  for (let i = left; i < left + width; i++) c.put(i, 2, "─", colors.rule)

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
  // Fill from the bottom so the latest turn is always in view.
  const blocks = v.turns.map((t) =>
    "tools" in t
      ? { lines: wrap(`⚙ ${toolSummary(t.tools)}`, width - 2, 2), fg: colors.dim, mark: "" }
      : {
          lines: wrap(t.text.replaceAll("**", ""), width - 2, MESSAGE_LINES),
          fg: t.fromUser ? brand.papyrus : colors.fg,
          mark: t.fromUser ? ">" : "",
        },
  )
  let y = bottom
  for (let b = blocks.length - 1; b >= 0 && y >= top; b--) {
    const block = blocks[b]!
    for (let l = block.lines.length - 1; l >= 0 && y >= top; l--, y--) {
      if (l === 0 && block.mark) c.text(left, y, block.mark, brand.gold, { attrs: BOLD })
      c.text(left + 2, y, block.lines[l]!, block.fg, { max: left + width })
    }
    y--
  }
}

function paint(v: View): Canvas {
  const c = new Canvas(v.width, v.height)
  const split = v.showPreview && v.width >= PREVIEW_MIN_WIDTH
  const listW = split ? Math.max(LIST_MIN_WIDTH, Math.floor(v.width * 0.35)) : v.width
  if (!v.showPreview || split) paintList(c, v, 0, listW)
  if (split) paintPreview(c, v, listW, v.width - listW)
  else if (v.showPreview) paintPreview(c, v, -2, v.width + 2)

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
    const hint = v.searching
      ? "type to filter · ⏎ done · esc clear"
      : v.hints.map((h) => h.desc).join(" · ")
    c.text(1, fy, hint, colors.dim)
  }
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

export function Browser({
  initial,
  load,
  onOpen,
}: {
  initial: Entry[]
  load: Load
  onOpen: (e: Entry) => void
}) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const activeKeys = useActiveKeys({ includeMetadata: true })
  const [entries, setEntries] = useState(initial)
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const searchingRef = useRef(false)
  const [showPreview, setShowPreview] = useState(true)
  const [selKey, setSelKey] = useState(() => keyOf(initial.find((e) => e.live) ?? initial[0]))
  // Keys can arrive before React re-renders; actions read the selection from here, not from render.
  const selKeyRef = useRef(selKey)
  const choose = (key: string) => {
    selKeyRef.current = key
    setSelKey(key)
  }
  const [scroll, setScroll] = useState(0)
  const [note, setNote] = useState("")
  const [confirming, setConfirmingState] = useState<Entry | null>(null)
  const confirmingRef = useRef<Entry | null>(null)
  const setConfirming = (e: Entry | null) => {
    confirmingRef.current = e
    setConfirmingState(e)
  }
  const busy = useRef(false)

  const refresh = async () => {
    if (busy.current) return
    busy.current = true
    try {
      setEntries(await load())
    } finally {
      busy.current = false
    }
  }
  const onInterval = useEffectEvent(() => void refresh().catch(() => {}))
  useEffect(() => {
    const id = setInterval(onInterval, REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const shown = useMemo(() => sections(entries.filter((e) => matches(e, query))), [entries, query])
  const flat = useMemo(() => shown.flatMap((s) => s.entries), [shown])
  const selIndex = Math.max(
    0,
    flat.findIndex((e) => keyOf(e) === selKey),
  )
  const sel = flat[selIndex] ?? null
  const rows: Row[] = []
  let n = 0
  for (const s of shown) {
    rows.push({ kind: "header", label: s.label, count: s.entries.length })
    const open = s.label !== "archived" || !!query || (sel !== null && s.entries.includes(sel))
    for (const entry of s.entries) if (open) rows.push({ kind: "entry", entry, n: ++n })
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
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flash = (text: string) => {
    setNote(text)
    clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(""), 2000)
  }
  const copyOut = (text: string | undefined, what: string) => {
    if (!text) return flash("no saved thread yet")
    void copy(text).then((ok) => flash(ok ? `copied ${what}` : "couldn't reach the clipboard"))
  }

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

  useKeyboard((key) => {
    const pending = confirmingRef.current
    if (pending) {
      setConfirming(null)
      if ((key.name === "y" || key.name === "x") && pending.live)
        void kill(pending.live).then(() => refresh())
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
      enabled: () => !searchingRef.current && !confirmingRef.current,
      bindings: browserKeys,
      commands: [
        { name: "quit", run: close },
        { name: "move-down", run: () => select(current().i + 1) },
        { name: "move-up", run: () => select(current().i - 1) },
        { name: "first", run: () => select(0) },
        { name: "last", run: () => select(flat.length - 1) },
        { name: "search", run: () => setSearching((searchingRef.current = true)) },
        { name: "preview", run: () => setShowPreview((s) => !s) },
        { name: "refresh", run: () => void refresh() },
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
            onOpen(e)
            close()
          },
        },
        { name: "half-down", run: () => select(current().i + Math.ceil(page / 2)) },
        { name: "half-up", run: () => select(current().i - Math.ceil(page / 2)) },
        { name: "page-down", run: () => select(current().i + page) },
        { name: "page-up", run: () => select(current().i - page) },
        { name: "screen-top", run: () => selectEntry(screen[0]) },
        {
          name: "screen-middle",
          run: () => selectEntry(screen[Math.floor((screen.length - 1) / 2)]),
        },
        { name: "screen-bottom", run: () => selectEntry(screen.at(-1)) },
        ...Array.from({ length: 9 }, (_, i) => ({
          name: `pick-${i + 1}`,
          run: () => selectEntry(screen[i]),
        })),
      ],
    }),
    [flat, top, page],
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
    note,
    confirming,
    hints: activeKeys.flatMap((key) =>
      typeof key.command === "string" && typeof key.bindingAttrs?.desc === "string"
        ? [{ command: key.command, desc: key.bindingAttrs.desc }]
        : [],
    ),
  })
  return <CanvasView canvas={canvas} />
}

/** Resolves with the entry picked, or null when the browser was quit. */
export async function runBrowser(initial: Entry[], load: Load): Promise<Entry | null> {
  let picked: Entry | null = null
  const { promise: closed, resolve } = Promise.withResolvers<void>()
  const renderer = await createCliRenderer({ useMouse: false, onDestroy: resolve })
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const gate = updateGate(renderer)
  createRoot(renderer).render(
    <KeymapProvider keymap={keymap}>
      <UpdateGate release={gate.release} onUpdate={gate.onUpdate}>
        <Browser initial={initial} load={load} onOpen={(e) => (picked = e)} />
      </UpdateGate>
    </KeymapProvider>,
  )
  await closed
  await gate.finish()
  return picked
}
