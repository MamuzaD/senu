import { classify } from "../detect/engine.ts"
import type { Agent, AgentState } from "../detect/manifest.ts"
import { capturePanes, identifyAgents, listPanes, tmux, type AgentPane, type Pane } from "../detect/panes.ts"

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
import { HEARTBEAT_OPTION } from "../watch/daemon.ts"
export { HEARTBEAT_OPTION }
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
 * Collects the rows once a second, doing as little as it can: a pane's agent
 * is looked up once (the `ps` behind it only reruns when its process
 * changes), and a pane is only captured again once its window has done
 * something since. It remembers each pane's last live state, too, so a rule
 * that says "leave the state alone" (a transcript viewer, a menu) can.
 */
export class Collector {
  /** pane → its agent, for the process it was running */
  private agents = new Map<string, { proc: string; agent: Agent | null }>()
  /** pane → its last live state, and the window activity and title it was read at */
  private live = new Map<string, { seen: string; state: AgentState }>()
  /** pane → its Codex label, and the window activity it was read at */
  private labels = new Map<string, { seen: string; label: string }>()

  private async identify(panes: Pane[]): Promise<AgentPane[]> {
    const proc = (p: Pane) => `${p.pid}\x1f${p.command}`
    const fresh = panes.filter((p) => this.agents.get(p.id)?.proc !== proc(p))
    if (fresh.length) {
      const found = new Map((await identifyAgents(fresh)).map((p) => [p.id, p.agent]))
      for (const p of fresh) this.agents.set(p.id, { proc: proc(p), agent: found.get(p.id) ?? null })
    }
    const live = new Set(panes.map((p) => p.id))
    for (const id of this.agents.keys()) if (!live.has(id)) this.agents.delete(id)
    return panes.flatMap((p) => {
      const agent = this.agents.get(p.id)!.agent
      return agent ? [{ ...p, agent }] : []
    })
  }

  async collect(): Promise<Collected> {
    const [panes, beat] = await Promise.all([listPanes(), tmux("show-options", "-gqv", HEARTBEAT_OPTION)])
    const daemon = daemonFrom(beat.out, Date.now() / 1000)
    const agents = await this.identify(panes)
    const seen = (p: AgentPane) => `${p.windowActivity}\x1f${p.oscTitle}`

    const classifying = agents.filter((p) => !trustsState(p.aiState, daemon))
    const reading = classifying.filter((p) => this.live.get(p.id)?.seen !== seen(p))
    const relabel = agents.filter((p) => p.agent === "codex" && this.labels.get(p.id)?.seen !== seen(p))
    const [screens, scrollback] = await Promise.all([
      capturePanes(reading.map((p) => p.id)),
      capturePanes(relabel.map((p) => p.id), LABEL_HISTORY),
    ])

    for (const p of reading) {
      const screen = screens.get(p.id) ?? ""
      const d = classify(p.agent, { screen, oscTitle: p.oscTitle }, this.live.get(p.id)?.state ?? null)
      this.live.set(p.id, { seen: seen(p), state: d.state })
    }
    for (const p of relabel) this.labels.set(p.id, { seen: seen(p), label: labelFor(p, scrollback.get(p.id) ?? null) })

    const rows = agents.map((p) => {
      const watched = trustsState(p.aiState, daemon)
      return {
        windowId: p.windowId,
        session: p.session,
        windowIndex: p.windowIndex,
        windowName: p.windowName,
        paneId: p.id,
        agent: p.agent,
        state: watched ? attentionOf(p.aiState)! : liveAttention(this.live.get(p.id)!.state),
        activity: p.windowActivity || 0,
        label: p.agent === "codex" ? this.labels.get(p.id)!.label : labelFor(p, null),
        source: watched ? ("watch" as const) : ("live" as const),
        active: p.active,
      }
    })

    const ids = new Set(agents.map((p) => p.id))
    for (const m of [this.live, this.labels]) for (const id of m.keys()) if (!ids.has(id)) m.delete(id)
    return { rows: foldWindows(rows), daemon }
  }
}
