import type { Config } from "~/config.ts"
import { printHelp } from "~/ui/help.ts"

import { readThread, renderThread, type ReadOptions } from "./read.ts"
import { UsageError } from "./search.ts"

const HELP = `usage: senu read [flags] <session>

Prints a saved Claude or Codex thread for handing its context to another agent.

  --line n                  focus on a search-hit line (default context: 3 turns each side)
    -B, --before-context n  turns before the target
    -A, --after-context n   turns after the target
    -C, --context n         turns before and after the target
  --tools                   include tool output
  --max-chars n             at most n characters of text, keeping whole turns (default 32k)
  --scope name              only profiles with this name, e.g. work
  --json                    print the kept turns as JSON
`

export async function readCommand(args: string[], config: Config): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    await printHelp(process.stdout, HELP)
    return 0
  }
  const options: ReadOptions = { session: "" }
  let json = false
  try {
    for (let i = 0; i < args.length; i++) {
      const raw = args[i]!
      const a =
        raw === "--before-context"
          ? "-B"
          : raw === "--after-context"
            ? "-A"
            : raw === "--context"
              ? "-C"
              : raw
      if (a === "--tools") options.tools = true
      else if (a === "--json") json = true
      else if (["--max-chars", "--scope", "--line", "-B", "-A", "-C"].includes(a)) {
        const value = args[++i]
        if (!value || value.startsWith("--")) throw new UsageError(`Missing value for ${a}`)
        if (a === "--max-chars") options.maxChars = Number(value)
        else if (a === "--scope") options.scope = value
        else if (a === "--line") options.line = Number(value)
        else {
          if (a === "-B" || a === "-C") options.before = Number(value)
          if (a === "-A" || a === "-C") options.after = Number(value)
        }
      } else if (!a.startsWith("-") && !options.session) options.session = a
      else throw new UsageError(`Unexpected argument ${a}`)
    }
    const thread = readThread(config, options, process.env, true)
    process.stdout.write(json ? `${JSON.stringify(thread, null, 2)}\n` : renderThread(thread))
    return 0
  } catch (e) {
    console.error(`senu read: ${e instanceof Error ? e.message : String(e)}`)
    if (!(e instanceof UsageError)) return 1
    console.error()
    await printHelp(process.stderr, HELP)
    return 2
  }
}
