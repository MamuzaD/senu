import type { Config, UsageProfile } from "~/config.ts"
import { setTmuxSocket } from "~/detect/panes.ts"
import { Collector } from "~/threads/live/collect.ts"
import { profileKey } from "~/usage/cache.ts"
import { formatDuration } from "~/usage/format.ts"

import { listEntries, openEntry, OpenError, refreshLive, type Entry } from "./entries.ts"
import { ResumeError } from "./resume.ts"

const HELP = `usage: senu threads [--live] [--json] [--profile key]... [--limit n] [-L socket | -S path]
       senu threads resume <session-id>

Lists agent threads, newest first.

  --live         only running agents
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

async function browse(
  config: Config,
  profiles: UsageProfile[],
  withUnthreaded: boolean,
  limit: number,
  live: boolean,
): Promise<number> {
  const load = async () => {
    const { entries, failed } = await listEntries(profiles, withUnthreaded)
    return { entries, failed }
  }
  const { entries, failed } = await load()
  warnFailed(failed)
  const collector = new Collector()
  const opts = { raiseGhosttyTab: config.agents.raiseGhosttyTab }
  let jumpFailed: unknown = null
  const { runBrowser } = await import("./browse/browser.tsx")
  const picked = await runBrowser(entries, {
    load: async () => (await load()).entries,
    watch: async () => {
      const { rows, panes, daemon } = await collector.collect()
      return {
        merge: (es) => refreshLive(es, { rows, panes }, withUnthreaded),
        scouting: daemon === "dead" || rows.some((r) => r.source === "live"),
      }
    },
    live,
    limit,
    jump: (e) => openEntry(e, opts).catch((err: unknown) => (jumpFailed = err)),
  })
  try {
    if (jumpFailed) throw jumpFailed
    return picked ? await openEntry(picked, opts) : 0
  } catch (e) {
    if (!(e instanceof ResumeError || e instanceof OpenError)) throw e
    console.error(`senu threads: ${e.message}`)
    return 1
  }
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
  if (!json && process.stdout.isTTY) return browse(config, profiles, !keys.length, limit, liveOnly)

  const { entries, failed } = await listEntries(profiles, !keys.length)
  const shown = entries.filter((e) => !liveOnly || e.live).slice(0, limit)
  warnFailed(failed)

  if (json) console.log(JSON.stringify(shown.map(entryJson), null, 2))
  else if (!shown.length) console.log(liveOnly ? "no running agents" : "no threads")
  else {
    const width = Math.max(...shown.map((e) => (e.thread?.profile ?? "-").length))
    for (const e of shown) console.log(entryLine(e, width))
  }
  return failed.length ? 1 : 0
}
