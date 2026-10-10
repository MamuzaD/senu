import type { Config, UsageProfile } from "~/config.ts"
import type { Agent } from "~/detect/manifest.ts"
import { listPanes, setTmuxSocket, tmux, type Pane } from "~/detect/panes.ts"
import { jump } from "~/threads/live/actions.ts"
import { Collector, type AgentRow, type Attention, type Collected } from "~/threads/live/collect.ts"
import { profileKey } from "~/usage/cache.ts"
import { formatDuration } from "~/usage/format.ts"

import { resume, ResumeError } from "./resume.ts"
import { runningThreads } from "./running.ts"
import { listThreads, type Thread } from "./thread.ts"

const HELP = `usage: senu threads [--live] [--json] [--profile key]... [--limit n] [-L socket | -S path]
       senu threads resume <session-id>

Lists agent threads, newest first.

  --live         only running agents; a picker in a terminal
  --json         print JSON
  --profile key  only this profile, e.g. codex-work
  --limit n      at most n
  -L, -S         the tmux server, as in tmux

resume jumps to a running thread, or reopens it in its own CLI.
`

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

async function listEntries(profiles: UsageProfile[], withUnthreaded: boolean) {
  const { threads, failed } = listThreads(profiles)
  let seen: TmuxState = { panes: [], rows: [], paneBySession: new Map() }
  if ((await tmux("info")).ok) {
    const [panes, { rows }] = await Promise.all([listPanes(), new Collector().collect()])
    seen = { panes, rows, paneBySession: await runningThreads(profiles, panes) }
  }
  return { entries: joinEntries(threads, seen, withUnthreaded), failed }
}

export const entryJson = (e: Entry) => ({
  sessionId: e.thread?.sessionId ?? null,
  agent: e.agent,
  profile: e.thread?.profile ?? null,
  title: e.title,
  cwd: e.cwd,
  updatedAt: new Date(e.updatedMs).toISOString(),
  live: e.live,
})

function entryLine(e: Entry, profileWidth: number): string {
  const age = formatDuration((Date.now() - e.updatedMs) / 1000)
  const profile = (e.thread?.profile ?? "-").padEnd(profileWidth)
  const id = e.thread?.sessionId ?? "-"
  return `${(e.live?.state ?? "").padEnd(7)}  ${age.padStart(6)}  ${profile}  ${id}  ${e.title}`
}

function warnFailed(failed: { profile: string; error: string }[]) {
  for (const f of failed) console.error(`senu threads: ${f.profile}: ${f.error}`)
}

async function resumeCommand(sessionId: string, config: Config): Promise<number> {
  const { entries, failed } = await listEntries(config.usage.profiles, false)
  warnFailed(failed)
  const entry = entries.find((e) => e.thread?.sessionId === sessionId)
  if (!entry?.thread) {
    console.error(`senu threads: no thread ${sessionId}`)
    return 1
  }
  if (entry.live) {
    if (!process.env.TMUX) {
      console.error(`senu threads: ${sessionId} is running in tmux session ${entry.live.session}`)
      return 1
    }
    await jump(entry.live, { raiseGhosttyTab: config.agents.raiseGhosttyTab })
    await tmux("select-pane", "-t", entry.live.paneId)
    return 0
  }
  try {
    return await resume(entry.thread)
  } catch (e) {
    if (!(e instanceof ResumeError)) throw e
    console.error(`senu threads: ${e.message}`)
    return 1
  }
}

function narrowed(profiles: UsageProfile[], byProfile: boolean, limit: number) {
  const all = new Collector()
  const { threads } = listThreads(profiles)
  return {
    async collect(): Promise<Collected> {
      const got = await all.collect()
      let rows = got.rows
      if (byProfile) {
        const panes = await listPanes()
        const seen = { panes, rows, paneBySession: await runningThreads(profiles, panes) }
        const windows = new Set(joinEntries(threads, seen, false).map((e) => e.live?.windowId))
        rows = rows.filter((r) => windows.has(r.windowId))
      }
      return { ...got, rows: rows.slice(0, limit) }
    },
  }
}

async function pickLive(
  config: Config,
  profiles: UsageProfile[],
  byProfile: boolean,
  limit: number,
): Promise<number> {
  if (!(await tmux("info")).ok) {
    console.error("senu threads: no tmux server")
    return 1
  }
  const { runPicker } = await import("~/threads/live/picker.tsx")
  return runPicker(narrowed(profiles, byProfile, limit), {
    raiseGhosttyTab: config.agents.raiseGhosttyTab,
  })
}

export async function threadsCommand(args: string[], config: Config): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP)
    return 0
  }
  const server: string[] = []
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if ((a === "-L" || a === "-S") && args[i + 1]) server.push(a, args[++i]!)
    else rest.push(a)
  }
  setTmuxSocket(server)

  if (rest[0] === "resume") {
    if (rest.length !== 2) {
      process.stderr.write(HELP)
      return 2
    }
    return resumeCommand(rest[1]!, config)
  }

  let json = false
  let liveOnly = false
  let limit = Infinity
  const keys: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a === "--json") json = true
    else if (a === "--live") liveOnly = true
    else if (a === "--profile" && rest[i + 1]) keys.push(rest[++i]!)
    else if (a === "--limit" && Number(rest[i + 1]) > 0) limit = Number(rest[++i])
    else {
      process.stderr.write(HELP)
      return 2
    }
  }
  const all = config.usage.profiles
  const unknown = keys.filter((k) => !all.some((p) => profileKey(p) === k))
  if (unknown.length) {
    console.error(
      `senu threads: no profile ${unknown.join(", ")} (have ${all.map(profileKey).join(", ")})`,
    )
    return 2
  }
  const profiles = keys.length ? all.filter((p) => keys.includes(profileKey(p))) : all
  if (liveOnly && !json && process.stdout.isTTY)
    return pickLive(config, profiles, keys.length > 0, limit)

  const { entries, failed } = await listEntries(profiles, !keys.length)
  warnFailed(failed)
  const shown = entries.filter((e) => !liveOnly || e.live).slice(0, limit)

  if (json) console.log(JSON.stringify(shown.map(entryJson), null, 2))
  else if (!shown.length) console.log(liveOnly ? "no running agents" : "no threads")
  else {
    const width = Math.max(...shown.map((e) => (e.thread?.profile ?? "-").length))
    for (const e of shown) console.log(entryLine(e, width))
  }
  return failed.length ? 1 : 0
}
