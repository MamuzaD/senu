import type { Config, Profile } from "~/config.ts"
import { setTmuxSocket } from "~/detect/panes.ts"
import { selfCommand } from "~/paths.ts"
import { selectProfiles } from "~/profiles.ts"
import type { SearchHit } from "~/search/search.ts"
import { mux } from "~/threads/live/mux.ts"
import { printHelp } from "~/ui/help.ts"
import { formatDuration } from "~/usage/format.ts"

import {
  listEntries,
  openEntry,
  OpenError,
  refreshLive,
  type Entry,
  type Scope,
} from "./entries.ts"
import { readPins } from "./pins.ts"
import { ResumeError } from "./resume.ts"

const HELP = `usage: senu threads [--live] [--json] [--profile name|key]... [--limit n] [-L socket | -S path]
       senu threads resume <session-id>

Browses agent threads, newest first, or lists them when piped.

  In the picker, / searches titles, then saved messages in allowed profiles.

  --live         only running agents
  --json         print JSON
  --profile name|key  select by name or key, repeatable
  --limit n      at most n
  -L, -S         the tmux server, as in tmux
  resume         jump to a running thread, or reopen it in its CLI
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
  const { entries, failed } = await listEntries(config.profiles, false)
  warnFailed(failed)
  // A session copied into another profile shows up twice; the running copy is the one to jump to
  const matched = entries.filter((e) => e.thread?.sessionId === sessionId)
  const entry = matched.find((e) => e.live) ?? matched[0]
  if (!entry) {
    console.error(`senu threads: no thread ${sessionId}`)
    return 1
  }
  try {
    return await openEntry(entry, config.threads)
  } catch (e) {
    if (!(e instanceof ResumeError || e instanceof OpenError)) throw e
    console.error(`senu threads: ${e instanceof OpenError ? `${sessionId} is ` : ""}${e.message}`)
    return 1
  }
}

async function browse(
  config: Config,
  profiles: Profile[],
  withUnthreaded: boolean,
  limit: number,
  live: boolean,
): Promise<number> {
  const collector = mux().collector()
  const failures = new Set<string>()
  const { threads } = config
  const recentMs = threads.recentDays * 24 * 60 * 60 * 1000
  const load = async (scope: Scope) => {
    const { entries, failed } = await listEntries(
      profiles,
      withUnthreaded,
      scope,
      recentMs,
      readPins(),
    )
    for (const f of failed) failures.add(`${f.profile}: ${f.error}`)
    return entries
  }
  // The first screen needs only the running threads, or those and the recent ones, so it reads
  // just those while the screen starts and leaves the rest to the browser
  const entries = load(live ? "live" : "recent")
  const { runBrowser } = await import("./browse/browser.tsx")
  let jumpFailed: unknown = null
  const picked = await runBrowser(entries, {
    load,
    searchMessages: async (query, signal) => {
      const proc = Bun.spawn(
        // One hit per thread, so the limit counts threads
        [
          ...selfCommand(),
          "search",
          "--messages",
          "--role",
          "all",
          "--limit",
          "100",
          "--per-session",
          "1",
          "--",
          query,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const stop = () => proc.kill()
      signal.addEventListener("abort", stop, { once: true })
      try {
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        // senu search exits 1 when some transcripts fail, but still prints what the rest held
        let result: { hits: SearchHit[] }
        try {
          result = JSON.parse(out)
        } catch {
          throw new Error(err.trim() || "Message search failed")
        }
        return new Map(
          result.hits.map((h) => [
            `${h.profile}:${h.session}`,
            `${h.path}:${h.line}\n${h.role}: ${h.excerpt}`,
          ]),
        )
      } finally {
        signal.removeEventListener("abort", stop)
      }
    },
    watch: async () => {
      const { rows, panes, daemon } = await collector.collect()
      return {
        merge: (es) => refreshLive(es, { rows, panes }, withUnthreaded),
        scouting: daemon === "dead" || rows.some((r) => r.source === "live"),
      }
    },
    live,
    limit,
    preview: live ? threads.livePreview : threads.preview,
    recentMs,
    partial: true,
    jump: (e) => openEntry(e, threads).catch((err: unknown) => (jumpFailed = err)),
  })
  for (const f of failures) console.error(`senu threads: ${f}`)
  try {
    if (jumpFailed) throw jumpFailed
    return picked ? await openEntry(picked, threads) : 0
  } catch (e) {
    if (!(e instanceof ResumeError || e instanceof OpenError)) throw e
    console.error(`senu threads: ${e.message}`)
    return 1
  }
}

export async function threadsCommand(args: string[], config: Config): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    await printHelp(process.stdout, HELP)
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
      await printHelp(process.stderr, HELP)
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
      await printHelp(process.stderr, HELP)
      return 2
    }
  }
  let profiles: typeof config.profiles
  try {
    profiles = selectProfiles(config.profiles, keys)
  } catch (e) {
    console.error(`senu threads: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  if (!json && process.stdout.isTTY) return browse(config, profiles, !keys.length, limit, liveOnly)

  const { entries, failed } = await listEntries(profiles, !keys.length, liveOnly ? "live" : "all")
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
