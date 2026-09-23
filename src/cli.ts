#!/usr/bin/env bun
import { ConfigError, loadConfig, type Config } from "./config.ts"
import { usageCommand } from "./usage/command.ts"

const HELP = `senu: watches AI coding agents in tmux

usage: senu <command> [args]

commands:
  usage     show Codex and Claude usage limits
  watch     classify agent panes in the background (not ported yet)
  agents    pick an agent to jump to (not ported yet)
  help      show this help
`

type Command = (args: string[], config: Config) => Promise<number>

const notPorted = (name: string): Command => async () => {
  console.error(`senu ${name}: not ported yet`)
  return 1
}

const COMMANDS: Record<string, Command> = {
  usage: usageCommand,
  watch: notPorted("watch"),
  agents: notPorted("agents"),
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
