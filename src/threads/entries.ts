import type { Profile, ThreadsConfig } from "~/config.ts"
import type { Agent } from "~/detect/manifest.ts"
import {
  foldWindows,
  type AgentRow,
  type Attention,
  type Collected,
  type PaneRow,
} from "~/threads/live/collect.ts"
import { mux, type Seen } from "~/threads/live/mux.ts"

import { resume } from "./resume.ts"
import { listThreads, threadKey, type Only, type Thread } from "./thread.ts"

export interface Live {
  state: Attention
  paneId: string
  windowId: string
  windowIndex: number
  paneIndex?: number | undefined
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

const unthreaded = (rows: PaneRow[], threaded: Set<string>, cwdOf: (paneId: string) => string) =>
  foldWindows(rows.filter((r) => !threaded.has(r.paneId))).map((r) =>
    agentEntry(r, cwdOf(r.paneId)),
  )

export function joinEntries(
  threads: Thread[],
  seen: Omit<Seen, "offPane">,
  withUnthreaded: boolean,
): Entry[] {
  const paneById = new Map(seen.panes.map((p) => [p.id, p]))
  const rowByPane = new Map(seen.rows.map((r) => [r.paneId, r]))
  const listed = new Set(threads.map((t) => threadKey(t.profile, t.sessionId)))
  const live = new Map<string, Live>()
  for (const [key, paneId] of seen.paneByThread) {
    const pane = paneById.get(paneId)
    if (!pane || !listed.has(key)) continue
    const state = rowByPane.get(paneId)?.state ?? "idle"
    const { windowId, windowIndex, paneIndex, session } = pane
    live.set(key, { state, paneId, windowId, windowIndex, paneIndex, session })
  }
  const threaded = new Set([...live.values()].map((l) => l.paneId))
  return [
    ...threads.map((t) => threadEntry(t, live.get(threadKey(t.profile, t.sessionId)) ?? null)),
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
  const keyOf = (t: Thread) => threadKey(t.profile, t.sessionId)
  const read = new Set(loaded.flatMap((e) => (e.thread ? [keyOf(e.thread)] : [])))
  const skipped = (e: Entry) => !!e.thread && !read.has(keyOf(e.thread)) && e.updatedMs < since
  const kept = last.flatMap((e) => (skipped(e) ? [e.live ? { ...e, live: null } : e] : []))
  return [...loaded, ...kept].toSorted((a, b) => b.updatedMs - a.updatedMs)
}

/** Which saved threads to read: all, the running ones, or those plus the pinned and any touched within `recentMs` */
export type Scope = "all" | "live" | "recent"

export async function listEntries(
  profiles: Profile[],
  withUnthreaded: boolean,
  scope: Scope = "all",
  recentMs = Infinity,
  pins: string[] = [],
) {
  const seen = await mux().seen(profiles)
  const ids = new Set(seen.paneByThread.keys())
  const only: Record<Scope, Only | undefined> = {
    all: undefined,
    live: { ids },
    recent: { ids: new Set([...ids, ...pins]), since: Date.now() - recentMs },
  }
  const { threads, failed } = listThreads(profiles, only[scope])
  return { entries: joinEntries(threads, seen, withUnthreaded), failed, offPane: seen.offPane }
}

export class OpenError extends Error {}

export async function openEntry(
  e: Entry,
  opts: Pick<ThreadsConfig, "raiseGhosttyTab" | "resume">,
): Promise<number> {
  if (e.live) {
    const failed = await mux().jump(e.live, opts)
    if (failed) throw new OpenError(failed)
    return 0
  }
  if (!e.thread) throw new OpenError("no saved thread to resume")
  return resume(e.thread, opts.resume)
}
