import { TextAttributes, createCliRenderer, type RGBA } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"

import { Canvas, CanvasView } from "~/ui/canvas.tsx"
import { DIVE_MS, paintSenu, rowGlow, type DivePlan } from "~/ui/dive.ts"
import { FPS, now, reducedMotion, useTicker } from "~/ui/motion.ts"
import { brand, colors, hex, icons, mix, noColor, states } from "~/ui/theme.ts"
import { formatDuration } from "~/usage/format.ts"

import { jump, kill } from "./actions.ts"
import { type AgentRow, type Attention, type Collected, type Collector } from "./collect.ts"

const REFRESH_MS = 1000

const RULE_ROW = 3
const LIST_TOP = RULE_ROW + 2
const PER_ROW = 3
const BAR_X = 1
const DOT_X = 3
const TEXT_X = 6

const BOLD = TextAttributes.BOLD
const faint = hex("#3b3d57")

const STARS: [number, number, string][] = [
  [0.14, 0, "·"],
  [0.31, 1, "·"],
  [0.47, 0, "✦"],
  [0.6, 2, "·"],
  [0.72, 0, "·"],
  [0.83, 1, "⋆"],
]

function age(activity: number, nowSeconds: number) {
  if (!activity) return ""
  const s = nowSeconds - activity
  return s < 60 ? "now" : formatDuration(s)
}

function windowNote(r: AgentRow) {
  const n = r.windowName
  if (!n || n === r.label || n === r.agent || /^\d+\.\d+/.test(n)) return ""
  return n
}

interface View {
  rows: AgentRow[]
  daemon: Collected["daemon"]
  sel: number
  top: number
  confirming: AgentRow | null
  dive: DivePlan | null
  width: number
  height: number
}

const visibleCount = (height: number) => Math.max(1, Math.floor((height - LIST_TOP - 1) / PER_ROW))

function paint(v: View): Canvas {
  const { width: W, height: H, rows } = v
  const c = new Canvas(W, H)
  const nowS = Date.now() / 1000
  const right = W - 2

  if (!noColor)
    for (const [fx, y, ch] of STARS)
      c.put(Math.round(fx * (W - 10)), y, ch, mix(faint, brand.papyrus, ch === "·" ? 0.25 : 0.45))
  let x = c.text(1, RULE_ROW - 1, "agents", brand.sand, { attrs: BOLD })
  x += 1
  for (const s of ["blocked", "working", "done", "idle"] as Attention[]) {
    const n = rows.filter((r) => r.state === s).length
    if (!n) continue
    x =
      c.text(x + 1, RULE_ROW - 1, states[s].glyph, states[s].fg, {
        attrs: states[s].bold ? BOLD : 0,
      }) + (s === "idle" ? 1 : 0)
    x = c.text(x + 1, RULE_ROW - 1, String(n), colors.muted)
  }
  for (let i = 1; i < W - 1; i++) c.put(i, RULE_ROW, "─", colors.rule)

  const visible = visibleCount(H)
  if (!rows.length) c.text(TEXT_X, LIST_TOP, "no agents in sight", colors.dim)
  const glow = v.dive ? rowGlow(v.dive) : { from: Infinity, k: 0 }
  for (let i = v.top; i < Math.min(rows.length, v.top + visible); i++) {
    const r = rows[i]!
    const y = LIST_TOP + (i - v.top) * PER_ROW
    const selected = i === v.sel
    const killing = v.confirming?.paneId === r.paneId
    const st = states[r.state]
    const when = age(r.activity, nowS)
    const lit = (fg: RGBA, col: number) =>
      selected && col >= glow.from ? mix(fg, brand.gold, glow.k) : fg

    if (selected)
      for (const dy of [0, 1]) c.put(BAR_X, y + dy, "▌", killing ? colors.bad : brand.gold)
    if (killing) c.put(DOT_X, y, "✕", colors.bad, { attrs: BOLD })
    else c.put(DOT_X, y, st.glyph, lit(st.fg, DOT_X), { attrs: st.bold ? BOLD : 0 })

    const whenX = right - when.length + 1
    const labelMax = when ? whenX - 2 : right + 1
    const label = r.label
    let lx = TEXT_X
    for (const { segment } of new Intl.Segmenter().segment(label)) {
      const fg = selected ? brand.papyrus : colors.fg
      const next = c.text(lx, y, segment, lit(fg, lx), {
        attrs: selected ? BOLD : 0,
        max: labelMax,
      })
      if (next === lx) {
        if (lx > TEXT_X)
          c.put(Math.min(lx, labelMax - 1), y, "…", selected ? brand.papyrus : colors.muted)
        break
      }
      lx = next
    }
    if (when) c.text(whenX, y, when, lit(colors.dim, whenX))

    const y2 = y + 1
    if (killing) {
      let kx = c.text(TEXT_X, y2, "kill this ", colors.bad)
      kx = c.text(kx, y2, r.agent, colors.bad, { attrs: BOLD })
      kx = c.text(kx, y2, "?  ", colors.bad)
      kx = c.text(kx, y2, "y", brand.papyrus, { attrs: BOLD })
      kx = c.text(kx, y2, " kill · ", colors.muted)
      kx = c.text(kx, y2, "n", brand.papyrus, { attrs: BOLD })
      c.text(kx, y2, " keep", colors.muted)
    } else {
      const agentFg = noColor ? colors.fg : r.agent === "codex" ? colors.codex : colors.claude
      let kx = c.text(TEXT_X, y2, r.agent === "codex" ? icons.codex : icons.claude, agentFg)
      kx = c.text(kx + 1, y2, r.agent, selected ? colors.muted : colors.dim)
      kx = c.text(kx + 2, y2, r.session, selected ? brand.sand : colors.muted, { max: right + 1 })
      kx = c.text(kx, y2, `:${r.windowIndex}`, colors.dim, { max: right + 1 })
      const note = windowNote(r)
      if (note) c.text(kx + 1, y2, note, colors.dim, { max: right + 1 })
    }
  }

  const fy = H - 1
  const more = [
    v.top > 0 ? `↑${v.top}` : "",
    rows.length > v.top + visible ? `↓${rows.length - v.top - visible}` : "",
  ]
    .filter(Boolean)
    .join(" ")
  const live = v.daemon === "dead" || rows.some((r) => r.source === "live")
  const note = v.dive ? "senu dives" : live ? "senu scouts live" : "senu keeps watch"
  const noteFg = v.dive ? brand.gold : live ? brand.dusk : brand.shadow
  const keys = v.confirming
    ? "y kill · any other key keeps it"
    : [..."j/k move · ⏎ jump · x kill · r refresh · q quit"].length +
          more.length +
          note.length +
          6 <=
        W
      ? "j/k move · ⏎ jump · x kill · r refresh · q quit"
      : "⏎ jump · x kill · q quit"
  c.text(1, fy, keys, colors.dim)
  const room = right - [...keys].length - 3
  const tail = more.length + note.length + 2 <= room ? [more, note] : [more]
  let tx = right + 1 - tail.filter(Boolean).reduce((n, s) => n + [...s].length + 2, -2)
  if (more && more.length <= room) tx = c.text(tx, fy, more, colors.muted) + 2
  if (tail.length === 2) c.text(tx, fy, note, noteFg)

  if (!noColor && W >= 30) {
    const target = { x: DOT_X, y: LIST_TOP + (v.sel - v.top) * PER_ROW }
    paintSenu(c, v.dive ?? { t: null, perch: { x: W - 5, y: RULE_ROW }, target })
  }
  return c
}

function Picker({
  collector,
  initial,
  raiseGhosttyTab,
}: {
  collector: Collector
  initial: Collected
  raiseGhosttyTab: boolean
}) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [data, setData] = useState(initial)
  const [cursor, setCursor] = useState<{ id: string | null; index: number }>({
    id: initial.rows[0]?.windowId ?? null,
    index: 0,
  })
  const [confirming, setConfirmingState] = useState<AgentRow | null>(null)
  // Key events can arrive before React renders; refs keep confirmation and cursor updates synchronous.
  const confirmingRef = useRef<AgentRow | null>(null)
  const setConfirming = (row: AgentRow | null) => {
    confirmingRef.current = row
    setConfirmingState(row)
  }
  const [diveAt, setDiveAt] = useState<number | null>(null)
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000))
  const busy = useRef(false)
  const last = useRef(JSON.stringify(initial))

  const refresh = async () => {
    if (busy.current) return
    busy.current = true
    try {
      const next = await collector.collect()
      const key = JSON.stringify(next)
      if (key !== last.current) {
        last.current = key
        setData(next)
      }
      setMinute(Math.floor(Date.now() / 60_000))
    } finally {
      busy.current = false
    }
  }

  useEffect(() => {
    const id = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(id)
  }, [])

  const rows = data.rows
  const indexOf = (c: typeof cursor, list: AgentRow[]) => {
    const i = list.findIndex((r) => r.windowId === c.id)
    return i >= 0 ? i : Math.max(0, Math.min(c.index, list.length - 1))
  }
  const sel = indexOf(cursor, rows)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor
  const move = (to: (i: number, n: number) => number) => {
    const list = rowsRef.current
    const k = Math.max(
      0,
      Math.min(to(indexOf(cursorRef.current, list), list.length), list.length - 1),
    )
    cursorRef.current = { id: list[k]?.windowId ?? null, index: k }
    setCursor(cursorRef.current)
  }

  const visible = visibleCount(height)
  const topRef = useRef(0)
  if (sel < topRef.current) topRef.current = sel
  else if (sel >= topRef.current + visible) topRef.current = sel - visible + 1
  topRef.current = Math.max(0, Math.min(topRef.current, Math.max(0, rows.length - visible)))
  const top = topRef.current

  const close = () => {
    renderer.destroy()
  }

  const go = (row: AgentRow) => {
    // Start navigation immediately; the dive must not delay the jump.
    const jumped = jump(row, { raiseGhosttyTab })
    if (reducedMotion || noColor || width < 30) {
      void jumped.finally(close)
      return
    }
    setDiveAt(now())
    void Promise.all([jumped, Bun.sleep(DIVE_MS)]).finally(close)
  }

  useKeyboard((key) => {
    if (diveAt != null) return
    const k = key.sequence === "G" ? "G" : key.name
    const confirming = confirmingRef.current
    if (confirming) {
      if (k === "y" || k === "x" || k === "d" || k === "return") {
        const row = confirming
        setConfirming(null)
        void kill(row).then(refresh)
      } else setConfirming(null)
      return
    }
    if (k === "q" || k === "escape") close()
    else if (k === "j" || k === "down") move((i) => i + 1)
    else if (k === "k" || k === "up") move((i) => i - 1)
    else if (k === "g" || k === "home") move(() => 0)
    else if (k === "G" || k === "end") move((_, n) => n - 1)
    else if (k === "r") void refresh()
    else if ((k === "x" || k === "d") && rowsRef.current.length)
      setConfirming(rowsRef.current[indexOf(cursorRef.current, rowsRef.current)]!)
    else if (k === "return" && rowsRef.current.length)
      go(rowsRef.current[indexOf(cursorRef.current, rowsRef.current)]!)
  })

  const diving = diveAt != null
  useTicker(diving ? FPS : 0)
  void minute

  const plan: DivePlan | null = diving
    ? {
        t: now() - diveAt,
        perch: { x: width - 5, y: RULE_ROW },
        target: { x: DOT_X, y: LIST_TOP + (sel - top) * PER_ROW },
      }
    : null
  const canvas = paint({
    rows,
    daemon: data.daemon,
    sel,
    top,
    confirming,
    dive: plan,
    width,
    height,
  })
  return <CanvasView canvas={canvas} />
}

export async function runPicker(
  collector: Collector,
  opts: { raiseGhosttyTab: boolean },
): Promise<number> {
  const { promise: closed, resolve } = Promise.withResolvers<void>()
  const [initial, renderer] = await Promise.all([
    collector.collect(),
    createCliRenderer({ useMouse: false, onDestroy: resolve }),
  ])
  createRoot(renderer).render(
    <Picker collector={collector} initial={initial} raiseGhosttyTab={opts.raiseGhosttyTab} />,
  )
  await closed
  process.exit(0)
}
