import { statSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { loadConfig } from "~/config.ts"
import { classify } from "~/detect/engine.ts"
import { AGENTS, overridePath, reloadManifests, type Agent } from "~/detect/manifest.ts"
import {
  AgentCache,
  capturePanes,
  listPanes,
  tmux,
  type AgentPane,
  type Pane,
} from "~/detect/panes.ts"
import { stateDir } from "~/paths.ts"

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

export const POLL_MS = 1000
const SERVER_GONE_MS = 30_000
/** tmux option stamped with epoch seconds so clients can detect a stale watcher. */
export const HEARTBEAT_OPTION = "@ai_watch_heartbeat"

export function optionCommands(
  current: Map<string, string>,
  wanted: Map<string, WindowState>,
): string[][] {
  const cmds: string[][] = []
  for (const [id, state] of wanted)
    if (current.get(id) !== state) cmds.push(["set-option", "-w", "-t", id, "@ai_state", state])
  for (const [id, state] of current)
    if (state && !wanted.has(id)) cmds.push(["set-option", "-uw", "-t", id, "@ai_state"])
  return cmds
}

export async function tmuxBatch(cmds: string[][]) {
  if (!cmds.length) return
  await tmux(...cmds.flatMap((c, i) => (i ? [";", ...c] : c)))
}

const currentStates = (panes: Pane[]) => new Map(panes.map((p) => [p.windowId, p.aiState]))

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
  private agents = new Map<string, Agent>()
  private identified = new AgentCache()
  private windows = new Map<string, WindowTrack>()
  private stamp = manifestStamp()

  get pending(): boolean {
    for (const t of this.panes.values()) if (isPending(t)) return true
    return false
  }

  reset() {
    this.panes.clear()
    this.agents.clear()
    this.identified.clear()
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
      agentPanes = await this.identified.identify(all)
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

    const toRead = full
      ? agentPanes
      : agentPanes.filter((p) => this.panes.has(p.id) && isPending(this.panes.get(p.id)!))
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

  snapshot(): { panes: Map<string, PaneTrack>; windows: Map<string, WindowTrack> } {
    return { panes: this.panes, windows: this.windows }
  }
}

async function chime(events: SoundEvent[]) {
  const sound = loadConfig().sound
  const opts = { enabled: effectiveSoundEnabled(sound.enabled), always: sound.always }
  const kinds = new Set<SoundKind>(events.filter((e) => shouldPlay(e, opts)).map((e) => e.kind))
  for (const kind of kinds) {
    const path = resolveSound(kind, sound[kind])
    if (path) play(path)
  }
}

export async function clearStates() {
  await tmuxBatch([
    ...optionCommands(currentStates(await listPanes()), new Map()),
    ["set-option", "-gu", HEARTBEAT_OPTION],
  ])
}

export const pidPath = (socket: string) =>
  join(stateDir, "watch", `${socket.replace(/[^\w.-]/g, "_")}.pid`)

/** Returns 0 immediately when another daemon already holds this tmux server's lock. */
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
  const stopSignal = new AbortController()
  const requestStop = () => {
    stopping = true
    stopSignal.abort()
  }
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const
  for (const sig of signals) process.on(sig, requestStop)
  const release = () => releasePidFile(lock)
  process.on("exit", release)

  let lastFull = 0
  let goneSince: number | null = null
  const poll = async (full: boolean, now: number) => {
    if (await watcher.tick(full, now)) {
      goneSince = null
    } else if (!(await tmux("display-message", "-p", "#{pid}")).ok) {
      watcher.reset()
      goneSince ??= now
    }
  }
  try {
    // `stopping` flips in the signal handler; each tick waits for the last.
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (!stopping) {
      const started = Date.now()
      const full = started - lastFull >= POLL_MS - IDLE_RECHECK_MS / 2
      if (full) lastFull = started
      await poll(full, started).catch(() => {})
      if (stopping || (goneSince !== null && started - goneSince > SERVER_GONE_MS)) break
      const wait = watcher.pending ? IDLE_RECHECK_MS : lastFull + POLL_MS - Date.now()
      try {
        await delay(Math.max(wait, 10), undefined, { signal: stopSignal.signal })
      } catch (error) {
        if (!stopping) throw error
      }
    }
  } finally {
    try {
      await clearStates()
    } finally {
      for (const sig of signals) process.off(sig, requestStop)
      process.off("exit", release)
      release()
    }
  }
  return 0
}
