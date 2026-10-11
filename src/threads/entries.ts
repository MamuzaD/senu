import type { UsageProfile } from "~/config.ts"
import type { Agent } from "~/detect/manifest.ts"
import { listPanes, tmux, type Pane } from "~/detect/panes.ts"
import { jump } from "~/threads/live/actions.ts"
import {
  Collector,
  foldWindows,
  type AgentRow,
  type Attention,
  type Collected,
  type PaneRow,
} from "~/threads/live/collect.ts"

import { resume } from "./resume.ts"
import { runningThreads } from "./running.ts"
import { listThreads, type Only, type Thread } from "./thread.ts"

export interface Live {
  state: Attention
  paneId: string
  windowId: string
  windowIndex: number
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
  live: {
    state: r.state,
    paneId: r.paneId,
    windowId: r.windowId,
    windowIndex: r.windowIndex,
    session: r.session,
  },
})

export interface TmuxState {
  panes: Pick<Pane, "id" | "windowId" | "windowIndex" | "session" | "cwd">[]
  rows: PaneRow[]
  paneBySession: Map<string, string>
}

const unthreaded = (rows: PaneRow[], threaded: Set<string>, cwdOf: (paneId: string) => string) =>
  foldWindows(rows.filter((r) => !threaded.has(r.paneId))).map((r) =>
    agentEntry(r, cwdOf(r.paneId)),
  )

export function joinEntries(threads: Thread[], seen: TmuxState, withUnthreaded: boolean): Entry[] {
  const paneById = new Map(seen.panes.map((p) => [p.id, p]))
  const rowByPane = new Map(seen.rows.map((r) => [r.paneId, r]))
  const listed = new Set(threads.map((t) => t.sessionId))
  const live = new Map<string, Live>()
  for (const [sessionId, paneId] of seen.paneBySession) {
    const pane = paneById.get(paneId)
    if (!pane || !listed.has(sessionId)) continue
    const state = rowByPane.get(paneId)?.state ?? "idle"
    const { windowId, windowIndex, session } = pane
    live.set(sessionId, { state, paneId, windowId, windowIndex, session })
  }
  const threaded = new Set([...live.values()].map((l) => l.paneId))
  return [
    ...threads.map((t) => threadEntry(t, live.get(t.sessionId) ?? null)),
    ...(withUnthreaded ? unthreaded(seen.rows, threaded, (id) => paneById.get(id)?.cwd ?? "") : []),
  ].toSorted((a, b) => b.updatedMs - a.updatedMs)
}

export function refreshLive(
  entries: Entry[],
  { rows, panes }: Pick<Collected, "rows" | "panes">,
  withUnthreaded: boolean,
): Entry[] {
  const rowByPane = new Map(rows.map((r) => [r.paneId, r]))
  const cwdByPane = new Map(panes.map((p) => [p.id, p.cwd]))
  const threaded = new Set<string>()
  const kept = entries.flatMap((e) => {
    if (!e.live) return [e]
    if (!e.thread) return []
    const r = rowByPane.get(e.live.paneId)
    if (!r) return [{ ...e, live: null }]
    threaded.add(r.paneId)
    const { state, windowId, windowIndex, session } = r
    return [{ ...e, live: { ...e.live, state, windowId, windowIndex, session } }]
  })
  const added = withUnthreaded ? unthreaded(rows, threaded, (id) => cwdByPane.get(id) ?? "") : []
  return [...kept, ...added].toSorted((a, b) => b.updatedMs - a.updatedMs)
}

/**
 * Puts a narrower load over the last list. Threads older than `since` it didn't read keep their
 * place, and any that were running have stopped, since every running thread is read. A newer one
 * it didn't read is gone.
 */
export function mergeLoaded(last: Entry[], loaded: Entry[], since = Infinity): Entry[] {
  const read = new Set(loaded.map((e) => e.thread?.sessionId))
  const skipped = (e: Entry) => !!e.thread && !read.has(e.thread.sessionId) && e.updatedMs < since
  const kept = last.flatMap((e) => (skipped(e) ? [e.live ? { ...e, live: null } : e] : []))
  return [...loaded, ...kept].toSorted((a, b) => b.updatedMs - a.updatedMs)
}

export const ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

/** Which saved threads to read: all, the running ones, or those plus any not yet archived */
export type Scope = "all" | "live" | "recent"

export async function listEntries(
  profiles: UsageProfile[],
  withUnthreaded: boolean,
  scope: Scope = "all",
) {
  let seen: TmuxState = { panes: [], rows: [], paneBySession: new Map() }
  if ((await tmux("info")).ok) {
    const panes = listPanes()
    const [{ rows }, paneBySession] = await Promise.all([
      new Collector().collect(),
      panes.then((ps) => runningThreads(profiles, ps)),
    ])
    seen = { panes: await panes, rows, paneBySession }
  }
  const ids = new Set(seen.paneBySession.keys())
  const only: Record<Scope, Only | undefined> = {
    all: undefined,
    live: { ids },
    recent: { ids, since: Date.now() - ARCHIVE_AFTER_MS },
  }
  const { threads, failed } = listThreads(profiles, only[scope])
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
