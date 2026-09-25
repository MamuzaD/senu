#!/usr/bin/env bun
import { ConfigError, loadConfig, type Config } from "./config.ts"
import { classifyCommand, explainCommand, scoutCommand } from "./detect/command.ts"
import { manifestsCommand } from "./detect/refresh.ts"
import { usageCommand } from "./usage/command.ts"
import { watchCommand } from "./watch/command.ts"

const HELP = `senu: watches AI coding agents in tmux

usage: senu <command> [args]

commands:
  vision    show Codex and Claude usage limits and today's cost
  watch     classify agent panes in the background, for the status bar
  agents    pick an agent to jump to (not ported yet)
  scout     scan agent panes, explain a state, or refresh detection manifests
  help      show this help
`

type Command = (args: string[], config: Config) => Promise<number>

const notPorted = (name: string): Command => async () => {
  console.error(`senu ${name}: not ported yet`)
  return 1
}

const COMMANDS: Record<string, Command> = {
  usage: usageCommand,
  watch: watchCommand,
  agents: notPorted("agents"),
  scout: scoutCommand,
  // The live tmux config still invokes manifests refresh; keep old spellings working.
  classify: classifyCommand,
  explain: explainCommand,
  manifests: (args, config) => manifestsCommand(args, config),
}

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv
  if (!name || name === "help" || name === "-h" || name === "--help") {
    process.stdout.write(HELP)
    return 0
  }

  const command = COMMANDS[name]
  if (!command) {
    console.error(`senu: unknown command "${name}"\n`)
    process.stderr.write(HELP)
    return 2
  }

  let config: Config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`senu: config: ${err.message}`)
      return 2
    }
    throw err
  }

  return command(args, config)
}

process.exitCode = await main(process.argv.slice(2))
