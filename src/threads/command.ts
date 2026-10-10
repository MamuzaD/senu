import type { Config, UsageProfile } from "~/config.ts"
import { listPanes, setTmuxSocket, tmux } from "~/detect/panes.ts"
import { Collector, type Collected } from "~/threads/live/collect.ts"
import { profileKey } from "~/usage/cache.ts"
import { formatDuration } from "~/usage/format.ts"

import { joinEntries, listEntries, openEntry, OpenError, type Entry } from "./entries.ts"
import { ResumeError } from "./resume.ts"
import { runningThreads } from "./running.ts"
import { listThreads } from "./thread.ts"

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
  if (!entry) {
    console.error(`senu threads: no thread ${sessionId}`)
    return 1
  }
  try {
    return await openEntry(entry, { raiseGhosttyTab: config.agents.raiseGhosttyTab })
  } catch (e) {
    if (!(e instanceof ResumeError || e instanceof OpenError)) throw e
    console.error(`senu threads: ${e instanceof OpenError ? `${sessionId} is ` : ""}${e.message}`)
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

  const load = async () => {
    const { entries, failed } = await listEntries(profiles, !keys.length)
    return { entries: entries.filter((e) => !liveOnly || e.live).slice(0, limit), failed }
  }
  const { entries: shown, failed } = await load()
  warnFailed(failed)

  if (json) console.log(JSON.stringify(shown.map(entryJson), null, 2))
  else if (!shown.length) console.log(liveOnly ? "no running agents" : "no threads")
  else {
    const width = Math.max(...shown.map((e) => (e.thread?.profile ?? "-").length))
    for (const e of shown) console.log(entryLine(e, width))
  }
  return failed.length ? 1 : 0
}
