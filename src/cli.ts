#!/usr/bin/env bun
import { version } from "../package.json"
import { ConfigError, loadConfig, type Config } from "./config.ts"

const TAGLINE = "watches AI coding agents in tmux"

type Command = {
  about: string
  run: (args: string[], config: Config) => Promise<number>
}

// Load only the selected command so short invocations avoid initializing unrelated modules.
const COMMANDS: Record<string, Command> = {
  vision: {
    about: "show Codex and Claude usage limits and today's cost",
    run: async (a, c) => (await import("./usage/command.ts")).usageCommand(a, c),
  },
  watch: {
    about: "classify agent panes in the background, for the status bar",
    run: async (a, c) => (await import("./watch/command.ts")).watchCommand(a, c),
  },
  agents: {
    about: "pick an agent to jump to",
    run: async (a, c) => (await import("./agents/command.ts")).agentsCommand(a, c),
  },
  scout: {
    about: "scan agent panes, explain a state, or refresh detection manifests",
    run: async (a, c) => (await import("./detect/command.ts")).scoutCommand(a, c),
  },
  sound: {
    about: "show or change Senu's chimes",
    run: async (a, c) => (await import("./watch/sound-command.ts")).soundCommand(a, c),
  },
}

async function help(): Promise<string> {
  const [{ banner, paint }, { brand }] = await Promise.all([
    import("./ui/banner.ts"),
    import("./ui/theme.ts"),
  ])
  const muted = (text: string) => paint([[text, brand.dusk]])
  const listed: [string, string][] = [
    ...Object.entries(COMMANDS).map(([name, { about }]): [string, string] => [name, about]),
    ["help", "show this help"],
    ["version", "print the version"],
  ]
  return [
    banner([[TAGLINE, brand.papyrus]]),
    `${muted("usage")}  senu ${muted("<command> [args]")}`,
    "",
    muted("commands"),
    ...listed.map(([name, about]) => `  ${paint([[name.padEnd(10), brand.gold]])}${about}`),
    "",
  ].join("\n")
}

const write = (stream: NodeJS.WriteStream, text: string) =>
  stream.write(stream.isTTY ? text : Bun.stripANSI(text))

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv
  if (!name || name === "help" || name === "-h" || name === "--help") {
    write(process.stdout, await help())
    return 0
  }
  if (name === "version" || name === "-v" || name === "--version") {
    console.log(`senu ${version}`)
    return 0
  }

  const command = COMMANDS[name]
  if (!command) {
    console.error(`senu: unknown command "${name}"\n`)
    write(process.stderr, await help())
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

  return command.run(args, config)
}

process.exitCode = await main(process.argv.slice(2))
