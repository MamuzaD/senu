#!/usr/bin/env bun
import { ConfigError, loadConfig, type Config } from "./config.ts"

const HELP = `senu: watches AI coding agents in tmux

usage: senu <command> [args]

commands:
  vision    show Codex and Claude usage limits and today's cost
  watch     classify agent panes in the background, for the status bar
  agents    pick an agent to jump to
  scout     scan agent panes, explain a state, or refresh detection manifests
  sound     show or change Senu's chimes
  help      show this help
`

type Command = (args: string[], config: Config) => Promise<number>

// loaded on demand: the watch daemon runs all day and shouldn't carry the popups' OpenTUI
const COMMANDS: Record<string, Command> = {
  vision: async (a, c) => (await import("./usage/command.ts")).usageCommand(a, c),
  watch: async (a, c) => (await import("./watch/command.ts")).watchCommand(a, c),
  agents: async (a, c) => (await import("./agents/command.ts")).agentsCommand(a, c),
  scout: async (a, c) => (await import("./detect/command.ts")).scoutCommand(a, c),
  sound: async (a, c) => (await import("./watch/sound-command.ts")).soundCommand(a, c),
  // The live tmux config still invokes manifests refresh; keep old spellings working.
  classify: async (a, c) => (await import("./detect/command.ts")).classifyCommand(a, c),
  explain: async (a, c) => (await import("./detect/command.ts")).explainCommand(a, c),
  manifests: async (a, c) => (await import("./detect/refresh.ts")).manifestsCommand(a, c),
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
