import { classify } from "../detect/engine.ts"
import type { Agent, AgentState } from "../detect/manifest.ts"
import { capturePanes, identifyAgents, listPanes, tmux, type AgentPane } from "../detect/panes.ts"

/**
 * What the picker lists: one row per agent window across every session, with
 * the state the status bar shows for it. The state comes from the window's
 * `@ai_state` when `senu watch` has written one, and from classifying the
 * pane live otherwise.
 */

/** The status bar's states: `done` is the daemon's "finished while you weren't looking". */
export type Attention = "blocked" | "working" | "done" | "idle"

/** What wants you most sorts first. */
export const PRIORITY: Record<Attention, number> = { blocked: 3, working: 2, done: 1, idle: 0 }

export interface AgentRow {
  windowId: string
  session: string
  windowIndex: number
  windowName: string
  /** The pane the row stands for: the one killing it closes. */
  paneId: string
  agent: Agent
  state: Attention
  /** Last activity in the window, epoch seconds. */
  activity: number
  label: string
  /** Whether the state came from the daemon (`watch`) or from classifying the screen now (`live`). */
  source: "watch" | "live"
}

/** An `@ai_state` value, or null when there's none (or it's not one senu writes). */
export function attentionOf(raw: string): Attention | null {
  return raw in PRIORITY ? (raw as Attention) : null
}

/** A live classification as the picker shows it. Codex's settled screen is `unknown`, which is idle. */
export const liveAttention = (s: AgentState): Attention => (s === "unknown" ? "idle" : s)

// ---------------------------------------------------------------- the daemon

/**
 * `senu watch` stamps this global option with the epoch seconds of each poll.
 * A stamp older than `HEARTBEAT_STALE_SECONDS` means the daemon died, and the
 * `@ai_state` it left behind is frozen, so the picker classifies live.
 */
export const HEARTBEAT_OPTION = "@ai_watch_heartbeat"
export const HEARTBEAT_STALE_SECONDS = 10

export type Daemon = "alive" | "dead" | "unknown"

/** The daemon's health from its heartbeat; `unknown` when it doesn't stamp one. */
export function daemonFrom(heartbeat: string, nowSeconds: number): Daemon {
  const beat = Number(heartbeat.trim())
  if (!heartbeat.trim() || !Number.isFinite(beat)) return "unknown"
  return nowSeconds - beat <= HEARTBEAT_STALE_SECONDS ? "alive" : "dead"
}

/**
 * Trust the window's `@ai_state`? Only if it has one and the daemon isn't
 * known to be dead. With no `@ai_state` (no daemon, or a window it hasn't
 * polled yet) the pane is classified live, as the python picker did.
 */
export const trustsState = (aiState: string, daemon: Daemon) => daemon !== "dead" && attentionOf(aiState) !== null

// ------------------------------------------------------------------- labels

/** Status glyphs and spinners agents put in front of the task in their title. */
const TITLE_JUNK = /^[\s✳✻✽✶✢·•●○◯⏵➤➜»›*⠀-⣿]+/u

/** The task an agent advertises in its title, or null if the title says nothing useful. */
export function titleTask(title: string, agent: Agent, session: string): string | null {
  let t = title.replace(TITLE_JUNK, "").trim()
  if (agent === "codex") {
    // Codex titles itself `<task> | <dir>`, or just `<dir>` before a thread has a name
    const bar = t.lastIndexOf(" | ")
    t = bar >= 0 ? t.slice(0, bar).trim() : ""
    if (/^action required$/i.test(t)) return null
  } else if (t === "Claude Code") return null
  return t && t !== session ? t : null
}

const CODEX_PROMPT = /^›\s+(\S.*?)\s*$/

/**
 * Codex's last user message, read off its screen: the last `› …` line that an
 * agent turn follows (a `•` bullet, a `─` separator or a `└` result). That
 * skips the input box and its greyed hints ("Ask Codex to do anything")
 * whether Codex is busy or settled.
 */
export function codexTask(screen: string): string | null {
  const lines = screen.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = CODEX_PROMPT.exec(lines[i]!)
    if (!m) continue
    const after = lines.slice(i + 1)
    if (after.some((a) => a.startsWith("•") || a.startsWith("─") || a.trimStart().startsWith("└"))) return m[1]!
  }
  return null
}

/** A row's label: Claude's task from its title; Codex's last prompt, then its title; else the window's name. */
export function labelFor(p: AgentPane, screen: string | null): string {
  if (p.agent === "codex") {
    const prompt = screen ? codexTask(screen) : null
    if (prompt) return prompt
  }
  return titleTask(p.oscTitle, p.agent, p.session) ?? (p.windowName || String(p.windowIndex))
}

// ----------------------------------------------------------- fold and sort

/** Rank rows: attention first, then the most recent activity. */
export function sortRows<T extends { state: Attention; activity: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => PRIORITY[b.state] - PRIORITY[a.state] || b.activity - a.activity)
}

/**
 * One row per window: the pane that wants you most stands for it (the active
 * pane on a tie), carrying the window's newest activity.
 */
export function foldWindows(rows: (AgentRow & { active: boolean })[]): AgentRow[] {
  const byWindow = new Map<string, AgentRow & { active: boolean }>()
  for (const r of rows) {
    const best = byWindow.get(r.windowId)
    if (!best) byWindow.set(r.windowId, r)
    else {
      const d = PRIORITY[r.state] - PRIORITY[best.state]
      const winner = d > 0 || (d === 0 && r.active && !best.active) ? r : best
      byWindow.set(r.windowId, { ...winner, activity: Math.max(r.activity, best.activity) })
    }
  }
  return sortRows([...byWindow.values()].map(({ active: _, ...r }) => r))
}

// ------------------------------------------------------------------ collect

/** Scrollback read for a Codex label, above the visible screen. */
const LABEL_HISTORY = 200

export interface Collected {
  rows: AgentRow[]
  daemon: Daemon
}

/**
 * Collects the rows, remembering each pane's last live state so a rule that
 * says "leave the state alone" (a transcript viewer, a menu) can.
 */
export class Collector {
  private previous = new Map<string, AgentState>()

  async collect(): Promise<Collected> {
    const [panes, beat] = await Promise.all([listPanes(), tmux("show-options", "-gqv", HEARTBEAT_OPTION)])
    const daemon = daemonFrom(beat.out, Date.now() / 1000)
    const agents = await identifyAgents(panes)

    const live = agents.filter((p) => !trustsState(p.aiState, daemon))
    const codex = agents.filter((p) => p.agent === "codex")
    const [screens, scrollback] = await Promise.all([
      capturePanes(live.map((p) => p.id)),
      capturePanes(codex.map((p) => p.id), LABEL_HISTORY),
    ])

    const seen = new Set<string>()
    const rows = agents.map((p) => {
      seen.add(p.id)
      let state: Attention
      let source: AgentRow["source"] = "watch"
      if (trustsState(p.aiState, daemon)) state = attentionOf(p.aiState)!
      else {
        const screen = screens.get(p.id) ?? ""
        const d = classify(p.agent, { screen, oscTitle: p.oscTitle }, this.previous.get(p.id) ?? null)
        this.previous.set(p.id, d.state)
        state = liveAttention(d.state)
        source = "live"
      }
      return {
        windowId: p.windowId,
        session: p.session,
        windowIndex: p.windowIndex,
        windowName: p.windowName,
        paneId: p.id,
        agent: p.agent,
        state,
        activity: p.windowActivity || 0,
        label: labelFor(p, scrollback.get(p.id) ?? null),
        source,
        active: p.active,
      }
    })
    for (const id of this.previous.keys()) if (!seen.has(id)) this.previous.delete(id)
    return { rows: foldWindows(rows), daemon }
  }
}
