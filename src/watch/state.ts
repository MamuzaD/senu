import type { Detection } from "~/detect/engine.ts"
import type { AgentState } from "~/detect/manifest.ts"

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

/** `unknown` remains distinct per pane and folds to idle for the window display. */
export type ObservedPaneState = PaneState | "unknown"

export interface PaneTrack {
  /** Last published state; null until a detection is published. */
  state: ObservedPaneState | null
  /** Start of a held working-to-idle/unknown transition, in the same ms as observe's now. */
  pendingSince: number | null
  confirmations: number
}

export const newPaneTrack = (): PaneTrack => ({ state: null, pendingSince: null, confirmations: 0 })

export const isPending = (t: PaneTrack) => t.pendingSince !== null

type Observation = Pick<Detection, "state" | "skipStateUpdate" | "visibleIdle">

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
  const next = d.state
  const idleCandidate = next === "idle" || next === "unknown"

  if (t.state === "working" && idleCandidate && !d.visibleIdle) {
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

const RANK: Record<ObservedPaneState, number> = { unknown: 1, idle: 1, working: 2, blocked: 3 }

export function fold(states: (ObservedPaneState | null)[]): PaneState | null {
  let best: ObservedPaneState | null = null
  for (const s of states) if (s && (!best || RANK[s] > RANK[best])) best = s
  return best === "unknown" ? "idle" : best
}

export interface WindowTrack {
  /** Folded state from the previous tick. */
  raw: PaneState
  /** Work finished while the window was not being viewed. */
  done: boolean
}

export interface WindowInput {
  id: string
  states: (ObservedPaneState | null)[]
  /** Whether the window is active in an attached session. */
  focused: boolean
}

export type SoundKind = "done" | "request"

export interface SoundEvent {
  kind: SoundKind
  window: string
  /** Whether the window was in front; `[sound].always` controls these chimes. */
  focused: boolean
}

export interface Step {
  /** `@ai_state` per window with agents. A window missing here should have no `@ai_state`. */
  display: Map<string, WindowState>
  sounds: SoundEvent[]
}

/** Mutates `windows`, removes absent windows, and suppresses sounds on each window's first tick. */
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
      if (raw === "blocked" && prev.raw !== "blocked")
        sounds.push({ kind: "request", window: w.id, focused: w.focused })
    }
    if (raw !== "idle" || w.focused) track.done = false
    track.raw = raw
    windows.set(w.id, track)
    display.set(w.id, raw === "idle" && track.done ? "done" : raw)
  }

  for (const id of windows.keys()) if (!live.has(id)) windows.delete(id)
  return { display, sounds }
}

export interface SoundOptions {
  enabled: boolean
  /** Whether focused windows may chime. */
  always: boolean
}

export const shouldPlay = (e: SoundEvent, o: SoundOptions) => o.enabled && (o.always || !e.focused)
