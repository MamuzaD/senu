import type { Config } from "~/config.ts"
import { allowedProfiles } from "~/privacy.ts"
import { printHelp } from "~/ui/help.ts"
import { profileKey } from "~/usage/cache.ts"

import { searchThreads, UsageError, type SearchOptions } from "./search.ts"

const HELP = `usage: senu search [flags] [--] <text>
       senu search --list-profiles [--profile name|key]...

Searches the titles and messages of saved Claude and Codex threads, newest first, as JSON.

  --threads                    only thread titles
  --messages                   only messages
  --role r                     user (you, default), assistant (agent replies), tool (output), or all
  --session <session>          only this session
  --limit n                    at most n hits, 1 to 100 (default 20)
  --per-session n              at most n hits per session (default 3)
  --profile name|key           select by name or key, repeatable
  --exclude-session <session>  leave out this session
  --list-profiles              print the profiles this caller can search
  --                           end of flags, for text starting with -
`

export async function searchCommand(args: string[], config: Config): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    await printHelp(process.stdout, HELP)
    return 0
  }
  const options: SearchOptions = { query: "", excludeSession: [] }
  let listProfiles = false
  let threads = false
  let messages = false
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!
      if (a === "--" && !options.query) options.query = args[++i] ?? ""
      else if (a === "--list-profiles") listProfiles = true
      else if (a === "--threads") threads = true
      else if (a === "--messages") messages = true
      else if (
        [
          "--session",
          "--role",
          "--limit",
          "--per-session",
          "--profile",
          "--exclude-session",
        ].includes(a)
      ) {
        const value = args[++i]
        if (!value || value.startsWith("--")) throw new UsageError(`Missing value for ${a}`)
        if (a === "--session") options.session = value
        if (a === "--role") options.role = value as SearchOptions["role"] & string
        if (a === "--limit") options.limit = Number(value)
        if (a === "--per-session") options.perSession = Number(value)
        if (a === "--profile") (options.profile ??= []).push(value)
        if (a === "--exclude-session") options.excludeSession!.push(value)
      } else if (!a.startsWith("-") && !options.query) options.query = a
      else throw new UsageError(`Unexpected argument ${a}`)
    }
    // Both flags mean both, as neither does
    if (threads !== messages) options.only = threads ? "threads" : "messages"
    if (listProfiles)
      console.log(
        JSON.stringify({
          profiles: allowedProfiles(config, process.env, options.profile, true)
            .filter((p) => p.kind !== "opencode")
            .map(profileKey),
        }),
      )
    else {
      const result = await searchThreads(config, options, process.env, true)
      console.log(JSON.stringify(result, null, 2))
      return result.failed.length ? 1 : 0
    }
    return 0
  } catch (e) {
    console.error(`senu search: ${e instanceof Error ? e.message : String(e)}`)
    if (!(e instanceof UsageError)) return 1
    console.error()
    await printHelp(process.stderr, HELP)
    return 2
  }
}
