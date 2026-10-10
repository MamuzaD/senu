import type { Config } from "~/config.ts"
import { profileKey } from "~/usage/cache.ts"
import { formatDuration } from "~/usage/format.ts"

import { resume, ResumeError } from "./resume.ts"
import { listThreads, type Thread } from "./thread.ts"

const HELP = `usage: senu threads [--json] [--profile key]... [--limit n]
       senu threads resume <session-id>

Lists agent threads, newest first.

  --json         print JSON
  --profile key  only this profile, e.g. codex-work
  --limit n      at most n threads

resume reopens a thread in its own CLI.
`

export const threadJson = (t: Thread) => ({
  sessionId: t.sessionId,
  agent: t.agent,
  profile: t.profile,
  title: t.title,
  cwd: t.cwd,
  updatedAt: new Date(t.updatedMs).toISOString(),
})

function threadLine(t: Thread, profileWidth: number): string {
  const age = formatDuration((Date.now() - t.updatedMs) / 1000)
  return `${age.padStart(6)}  ${t.profile.padEnd(profileWidth)}  ${t.sessionId}  ${t.title}`
}

function warnFailed(failed: { profile: string; error: string }[]) {
  for (const f of failed) console.error(`senu threads: ${f.profile}: ${f.error}`)
}

async function resumeCommand(sessionId: string, config: Config): Promise<number> {
  const { threads, failed } = listThreads(config.usage.profiles)
  warnFailed(failed)
  const thread = threads.find((t) => t.sessionId === sessionId)
  if (!thread) {
    console.error(`senu threads: no thread ${sessionId}`)
    return 1
  }
  try {
    return await resume(thread)
  } catch (e) {
    if (!(e instanceof ResumeError)) throw e
    console.error(`senu threads: ${e.message}`)
    return 1
  }
}

export async function threadsCommand(args: string[], config: Config): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP)
    return 0
  }
  if (args[0] === "resume") {
    if (args.length !== 2) {
      process.stderr.write(HELP)
      return 2
    }
    return resumeCommand(args[1]!, config)
  }

  let json = false
  let limit = Infinity
  const keys: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--json") json = true
    else if (a === "--profile" && args[i + 1]) keys.push(args[++i]!)
    else if (a === "--limit" && Number(args[i + 1]) > 0) limit = Number(args[++i])
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

  const { threads, failed } = listThreads(profiles)
  warnFailed(failed)
  const shown = threads.slice(0, limit)

  if (json) {
    console.log(JSON.stringify(shown.map(threadJson), null, 2))
  } else if (!shown.length) {
    console.log("no threads")
  } else {
    const width = Math.max(...shown.map((t) => t.profile.length))
    for (const t of shown) console.log(threadLine(t, width))
  }
  return failed.length ? 1 : 0
}
