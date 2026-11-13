import type { Config } from "~/config.ts"
import { allowedProfiles } from "~/privacy.ts"
import { profileKey } from "~/usage/cache.ts"

import { searchThreads, type SearchOptions } from "./search.ts"

export async function searchCommand(args: string[], config: Config): Promise<number> {
  const help =
    "usage: senu search <literal text> [--session id] [--role user|assistant|tool|all] [--limit 1..100] [--scope name] [--exclude-session id] [--scope-only]"
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help)
    return 0
  }
  const options: SearchOptions = { query: "", excludeSession: [] }
  let scopeOnly = false
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!
      if (a === "--scope-only") scopeOnly = true
      else if (["--session", "--role", "--limit", "--scope", "--exclude-session"].includes(a)) {
        const value = args[++i]
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${a}`)
        if (a === "--session") options.session = value
        if (a === "--role") options.role = value as SearchOptions["role"] & string
        if (a === "--limit") options.limit = Number(value)
        if (a === "--scope") options.scope = value
        if (a === "--exclude-session") options.excludeSession!.push(value)
      } else if (!a.startsWith("-") && !options.query) options.query = a
      else throw new Error(`Unexpected argument ${a}`)
    }
    if (scopeOnly)
      console.log(
        JSON.stringify({
          profiles: allowedProfiles(config, process.env, options.scope, true)
            .filter((p) => p.kind !== "opencode")
            .map(profileKey),
        }),
      )
    else {
      const result = searchThreads(config, options, process.env, true)
      console.log(JSON.stringify(result, null, 2))
      return result.failed.length ? 1 : 0
    }
    return 0
  } catch (e) {
    console.error(`senu search: ${e instanceof Error ? e.message : String(e)}\n${help}`)
    return 2
  }
}
