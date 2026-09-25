import type { Detection } from "../detect/engine.ts"
import type { AgentState } from "../detect/manifest.ts"

/**
 * The daemon's state machine, kept pure so it can be tested without tmux.
 * Per pane: herdr's publish rules, including its hold on a working → idle flip.
 * Per window: the folded state written to `@ai_state`, the sticky `done`, and
 * which transitions deserve a sound.
 */

/** A pane's settled state. */
export type PaneState = "idle" | "working" | "blocked"
/** What `@ai_state` shows. `done` is idle that you haven't looked at yet. */
export type WindowState = PaneState | "done"

/**
 * herdr's idle confirmation (`src/pane/agent_detection.rs`): a working → idle
 * flip without visible idle evidence is held, re-checked every 100 ms, and
 * published after three more idle reads or 700 ms, whichever comes first. A
 * spinner that blinks out for one frame never reaches the status bar.
 */
export const IDLE_RECHECK_MS = 100
export const IDLE_CONFIRMATIONS = 3
export const IDLE_CAP_MS = 700

/**
 * `unknown` is herdr's settled fallback for a Codex screen with no rule
 * matching, which in practice is Codex sitting at its prompt. It reads as idle
 * everywhere here, so working → unknown is a finish. (The only other `unknown`
 * rules are `skip_state_update` ones, which never reach this.)
 */
export const settle = (s: AgentState): PaneState => (s === "unknown" ? "idle" : s)

export interface PaneTrack {
  /** The published state; null until the first detection that isn't skipped. */
  state: PaneState | null
  /** When a held working → idle flip was first seen. */
  pendingSince: number | null
  confirmations: number
}

export const newPaneTrack = (): PaneTrack => ({ state: null, pendingSince: null, confirmations: 0 })

export const isPending = (t: PaneTrack) => t.pendingSince !== null

type Observation = Pick<Detection, "state" | "skipStateUpdate" | "visibleIdle">

/** Feeds one detection into a pane's track. True if the published state changed. */
export function observe(t: PaneTrack, d: Observation, now: number): boolean {
  const clear = () => {
    t.pendingSince = null
    t.confirmations = 0
  }
  // herdr drops a skip_state_update read entirely: a transcript viewer or a menu says nothing
  if (d.skipStateUpdate) {
    clear()
    return false
  }
  const next = settle(d.state)

  if (t.state === "working" && next === "idle" && !d.visibleIdle) {
    if (t.pendingSince === null) {
      t.pendingSince = now
      t.confirmations = 0
      return false
    }
    if (now - t.pendingSince < IDLE_CAP_MS && ++t.confirmations < IDLE_CONFIRMATIONS) return false
  }
  clear()
  if (next === t.state) return false
  t.state = next
  return true
}

const RANK: Record<PaneState, number> = { idle: 1, working: 2, blocked: 3 }

/** `blocked` > `working` > `idle`; null for a window with no settled panes. */
export function fold(states: (PaneState | null)[]): PaneState | null {
  let best: PaneState | null = null
  for (const s of states) if (s && (!best || RANK[s] > RANK[best])) best = s
  return best
}

export interface WindowTrack {
  /** The folded state last tick. */
  raw: PaneState
  /** Finished while you weren't looking. */
  done: boolean
}

export interface WindowInput {
  id: string
  states: (PaneState | null)[]
  /** The active window of an attached session: you're looking at it. */
  focused: boolean
}

export type SoundKind = "done" | "request"

export interface SoundEvent {
  kind: SoundKind
  window: string
  /** Whether the window was in front; only `@ai_sound_always` chimes then. */
  focused: boolean
}

export interface Step {
  /** `@ai_state` per window with agents. A window missing here should have no `@ai_state`. */
  display: Map<string, WindowState>
  sounds: SoundEvent[]
}

/**
 * One tick for every window that has agent panes. Updates `windows` in place,
 * dropping windows that are gone. A window's first tick never chimes, so a
 * daemon restart doesn't replay what's already on screen.
 */
export function step(windows: Map<string, WindowTrack>, inputs: WindowInput[]): Step {
  const display = new Map<string, WindowState>()
  const sounds: SoundEvent[] = []
  const live = new Set<string>()

  for (const w of inputs) {
    const raw = fold(w.states)
    if (!raw) continue
    live.add(w.id)
    const prev = windows.get(w.id)
    const track: WindowTrack = prev ?? { raw, done: false }

    if (prev) {
      if (raw === "idle" && prev.raw === "working") {
        if (!w.focused) track.done = true
        sounds.push({ kind: "done", window: w.id, focused: w.focused })
      }
      if (raw === "blocked" && prev.raw !== "blocked") sounds.push({ kind: "request", window: w.id, focused: w.focused })
    }
    // new activity, or you looked: either way nothing is waiting unseen
    if (raw !== "idle" || w.focused) track.done = false
    track.raw = raw
    windows.set(w.id, track)
    display.set(w.id, raw === "idle" && track.done ? "done" : raw)
  }

  for (const id of windows.keys()) if (!live.has(id)) windows.delete(id)
  return { display, sounds }
}

export interface SoundOptions {
  /** `@ai_sound_enabled`: anything but off. */
  enabled: boolean
  /** `@ai_sound_always`: chime for the focused window too. */
  always: boolean
}

export const shouldPlay = (e: SoundEvent, o: SoundOptions) => o.enabled && (o.always || !e.focused)

/** tmux-style booleans, as the Python read them. */
export const isOff = (v: string) => ["0", "off", "false", "no"].includes(v.trim().toLowerCase())
export const isOn = (v: string) => ["1", "on", "true", "yes"].includes(v.trim().toLowerCase())
