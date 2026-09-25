import { statSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../config.ts"
import { classify } from "../detect/engine.ts"
import { AGENTS, overridePath, reloadManifests, type Agent } from "../detect/manifest.ts"
import { capturePanes, identifyAgents, listPanes, tmux, type AgentPane, type Pane } from "../detect/panes.ts"
import { stateDir } from "../paths.ts"
import { claimPidFile, releasePidFile } from "./lock.ts"
import { effectiveSoundEnabled } from "./sound-state.ts"
import { play, resolveSound } from "./sounds.ts"
import {
  IDLE_RECHECK_MS,
  isPending,
  newPaneTrack,
  observe,
  shouldPlay,
  step,
  type PaneTrack,
  type SoundEvent,
  type SoundKind,
  type WindowInput,
  type WindowState,
  type WindowTrack,
} from "./state.ts"

/**
 * The watch loop. A full tick, once a second, costs one `list-panes`, at most
 * one `ps` and one batched capture of the agent panes, however many there are.
 * While a pane holds a working → idle flip, herdr's 100 ms re-checks capture
 * just that pane. `@ai_state` is diffed against what tmux has, so a write that
 * failed (a window closing mid-tick) is retried on the next tick, and a stale
 * value left by a crashed daemon is cleared on the first.
 */

export const POLL_MS = 1000
/** Give up on a tmux server that's been gone this long; its successor starts its own daemon. */
const SERVER_GONE_MS = 30_000
/** Stamped (epoch seconds) with every write, so `senu agents` can tell a live daemon from a dead one's leftovers. */
export const HEARTBEAT_OPTION = "@ai_watch_heartbeat"

/** tmux commands that bring each window's `@ai_state` from `current` to `wanted`. */
export function optionCommands(current: Map<string, string>, wanted: Map<string, WindowState>): string[][] {
  const cmds: string[][] = []
  for (const [id, state] of wanted) if (current.get(id) !== state) cmds.push(["set-option", "-w", "-t", id, "@ai_state", state])
  for (const [id, state] of current) if (state && !wanted.has(id)) cmds.push(["set-option", "-uw", "-t", id, "@ai_state"])
  return cmds
}

/** Several tmux commands in one process, `;`-separated. */
export async function tmuxBatch(cmds: string[][]) {
  if (!cmds.length) return
  await tmux(...cmds.flatMap((c, i) => (i ? [";", ...c] : c)))
}

/** Each window's `@ai_state` as tmux has it now. */
const currentStates = (panes: Pane[]) => new Map(panes.map((p) => [p.windowId, p.aiState]))

/** A signature of the override files, so the loop notices an edit or a refresh. */
function manifestStamp(): string {
  return AGENTS.map((a) => {
    try {
      const s = statSync(overridePath(a))
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return "-"
    }
  }).join(" ")
}

export class Watcher {
  private panes = new Map<string, PaneTrack>()
  /** Pane id → agent, from the last full tick; re-checks reuse it instead of running `ps`. */
  private agents = new Map<string, Agent>()
  private windows = new Map<string, WindowTrack>()
  private stamp = manifestStamp()

  /** Some pane is holding a working → idle flip and wants a re-check soon. */
  get pending(): boolean {
    for (const t of this.panes.values()) if (isPending(t)) return true
    return false
  }

  /** Forget everything, e.g. after the server restarted and window ids mean new windows. */
  reset() {
    this.panes.clear()
    this.agents.clear()
    this.windows.clear()
  }

  /**
   * One poll. `full` re-lists agents and reads every agent pane; otherwise only
   * the panes holding a pending idle are read. `dry` writes and plays nothing.
   * Returns false if tmux had no panes.
   */
  async tick(full: boolean, now = Date.now(), dry = false): Promise<boolean> {
    const all = await listPanes()
    if (!all.length) return false

    let agentPanes: AgentPane[]
    if (full) {
      agentPanes = await identifyAgents(all)
      this.agents = new Map(agentPanes.map((p) => [p.id, p.agent]))
      const stamp = manifestStamp()
      if (stamp !== this.stamp) {
        this.stamp = stamp
        reloadManifests()
      }
    } else {
      agentPanes = all.flatMap((p) => {
        const agent = this.agents.get(p.id)
        return agent ? [{ ...p, agent }] : []
      })
    }

    const toRead = full ? agentPanes : agentPanes.filter((p) => this.panes.has(p.id) && isPending(this.panes.get(p.id)!))
    const screens = await capturePanes(toRead.map((p) => p.id))
    for (const p of toRead) {
      const screen = screens.get(p.id)
      if (screen === undefined) continue
      let track = this.panes.get(p.id)
      if (!track) this.panes.set(p.id, (track = newPaneTrack()))
      observe(track, classify(p.agent, { screen, oscTitle: p.oscTitle }), now)
    }
    const live = new Set(agentPanes.map((p) => p.id))
    for (const id of this.panes.keys()) if (!live.has(id)) this.panes.delete(id)

    const byWindow = new Map<string, WindowInput>()
    for (const p of agentPanes) {
      let w = byWindow.get(p.windowId)
      if (!w) byWindow.set(p.windowId, (w = { id: p.windowId, states: [], focused: false }))
      w.states.push(this.panes.get(p.id)?.state ?? null)
      if (p.windowActive && p.sessionAttached) w.focused = true
    }

    const { display, sounds } = step(this.windows, [...byWindow.values()])
    if (dry) return true
    await tmuxBatch([
      ...optionCommands(currentStates(all), display),
      ["set-option", "-g", HEARTBEAT_OPTION, String(Math.floor(Date.now() / 1000))],
    ])
    if (sounds.length) await chime(sounds)
    return true
  }

  /** Every window's state, for `senu watch once`. */
  snapshot(): { panes: Map<string, PaneTrack>; windows: Map<string, WindowTrack> } {
    return { panes: this.panes, windows: this.windows }
  }
}

/** Plays at most one of each kind per tick, reading sound preferences only when something chimes. */
async function chime(events: SoundEvent[]) {
  const sound = loadConfig().sound
  const opts = { enabled: effectiveSoundEnabled(sound.enabled), always: sound.always }
  const kinds = new Set<SoundKind>(events.filter((e) => shouldPlay(e, opts)).map((e) => e.kind))
  for (const kind of kinds) {
    const path = resolveSound(kind, sound[kind])
    if (path) play(path)
  }
}

/** Unsets every `@ai_state` and the heartbeat, so a stopped daemon leaves no stale dots behind. */
export async function clearStates() {
  await tmuxBatch([...optionCommands(currentStates(await listPanes()), new Map()), ["set-option", "-gu", HEARTBEAT_OPTION]])
}

export const pidPath = (socket: string) => join(stateDir, "watch", `${socket.replace(/[^\w.-]/g, "_")}.pid`)

/** The daemon. Returns at once (0) if another one already watches this server. */
export async function runDaemon(): Promise<number> {
  const { ok, out } = await tmux("display-message", "-p", "#{socket_path}")
  const socket = out.trim()
  if (!ok || !socket) {
    console.error("senu watch: no tmux server")
    return 1
  }
  const lock = pidPath(socket)
  if (!claimPidFile(lock)) return 0

  const watcher = new Watcher()
  let stopping = false
  let inflight: Promise<unknown> = Promise.resolve()
  const stop = async () => {
    if (stopping) return
    stopping = true
    try {
      await inflight // a tick finishing after the clear would write a state back
      await clearStates()
    } finally {
      releasePidFile(lock)
      process.exit(0)
    }
  }
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, stop)
  process.on("exit", () => releasePidFile(lock))

  let lastFull = 0
  let goneSince: number | null = null
  const poll = async (full: boolean, now: number) => {
    if (await watcher.tick(full, now)) {
      goneSince = null
    } else if (!(await tmux("display-message", "-p", "#{pid}")).ok) {
      // no server: remember nothing, and give up if it doesn't come back
      watcher.reset()
      goneSince ??= now
    }
  }
  while (!stopping) {
    const started = Date.now()
    // full ticks keep a steady once-a-second beat; re-checks slot in between
    const full = started - lastFull >= POLL_MS - IDLE_RECHECK_MS / 2
    if (full) lastFull = started
    inflight = poll(full, started).catch(() => {}) // one bad poll never kills the daemon
    await inflight
    if (goneSince !== null && started - goneSince > SERVER_GONE_MS) break
    const wait = watcher.pending ? IDLE_RECHECK_MS : lastFull + POLL_MS - Date.now()
    await Bun.sleep(Math.max(wait, 10))
  }
  releasePidFile(lock)
  return 0
}
