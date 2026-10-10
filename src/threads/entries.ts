import type { UsageProfile } from "~/config.ts"
import type { Agent } from "~/detect/manifest.ts"
import { listPanes, tmux, type Pane } from "~/detect/panes.ts"
import { jump } from "~/threads/live/actions.ts"
import { Collector, type AgentRow, type Attention } from "~/threads/live/collect.ts"

import { resume } from "./resume.ts"
import { runningThreads } from "./running.ts"
import { listThreads, type Thread } from "./thread.ts"

export interface Live {
  state: Attention
  paneId: string
  windowId: string
  session: string
}

export interface Entry {
  thread: Thread | null
  agent: Agent
  title: string
  cwd: string
  updatedMs: number
  live: Live | null
}

const threadEntry = (t: Thread, live: Live | null): Entry => ({
  thread: t,
  agent: t.agent,
  title: t.title,
  cwd: t.cwd,
  updatedMs: t.updatedMs,
  live,
})

export const agentEntry = (r: AgentRow, cwd: string): Entry => ({
  thread: null,
  agent: r.agent,
  title: r.label,
  cwd,
  updatedMs: r.activity * 1000,
  live: { state: r.state, paneId: r.paneId, windowId: r.windowId, session: r.session },
})

export interface TmuxState {
  panes: Pick<Pane, "id" | "windowId" | "session" | "cwd">[]
  rows: AgentRow[]
  paneBySession: Map<string, string>
}

export function joinEntries(threads: Thread[], seen: TmuxState, withUnthreaded: boolean): Entry[] {
  const paneById = new Map(seen.panes.map((p) => [p.id, p]))
  const rowByWindow = new Map(seen.rows.map((r) => [r.windowId, r]))
  const listed = new Set(threads.map((t) => t.sessionId))
  const live = new Map<string, Live>()
  const threaded = new Set<string>()
  for (const [sessionId, paneId] of seen.paneBySession) {
    const pane = paneById.get(paneId)
    if (!pane || !listed.has(sessionId)) continue
    const state = rowByWindow.get(pane.windowId)?.state ?? "idle"
    live.set(sessionId, { state, paneId, windowId: pane.windowId, session: pane.session })
    threaded.add(pane.windowId)
  }
  const unthreaded = withUnthreaded
    ? seen.rows
        .filter((r) => !threaded.has(r.windowId))
        .map((r) => agentEntry(r, paneById.get(r.paneId)?.cwd ?? ""))
    : []
  return [
    ...threads.map((t) => threadEntry(t, live.get(t.sessionId) ?? null)),
    ...unthreaded,
  ].toSorted((a, b) => b.updatedMs - a.updatedMs)
}

export async function listEntries(profiles: UsageProfile[], withUnthreaded: boolean) {
  const { threads, failed } = listThreads(profiles)
  let seen: TmuxState = { panes: [], rows: [], paneBySession: new Map() }
  if ((await tmux("info")).ok) {
    const [panes, { rows }] = await Promise.all([listPanes(), new Collector().collect()])
    seen = { panes, rows, paneBySession: await runningThreads(profiles, panes) }
  }
  return { entries: joinEntries(threads, seen, withUnthreaded), failed }
}

export class OpenError extends Error {}

export async function openEntry(e: Entry, opts: { raiseGhosttyTab: boolean }): Promise<number> {
  if (e.live) {
    if (!process.env.TMUX) throw new OpenError(`running in tmux session ${e.live.session}`)
    await jump(e.live, opts)
    await tmux("select-pane", "-t", e.live.paneId)
    return 0
  }
  if (!e.thread) throw new OpenError("no saved thread to resume")
  return resume(e.thread)
}
