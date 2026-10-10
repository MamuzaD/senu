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
  threads: {
    about: "list past and running conversations, or resume one",
    run: async (a, c) => (await import("./threads/command.ts")).threadsCommand(a, c),
  },
  scout: {
    about: "scan agent panes, explain a state, or refresh detection manifests",
    run: async (a, c) => (await import("./detect/command.ts")).scoutCommand(a, c),
  },
  sound: {
    about: "show or change Senu's chimes",
    run: async (a, c) => (await import("./watch/sound-command.ts")).soundCommand(a, c),
  },
  update: {
    about: "update senu to the latest release",
    run: async (a, c) => (await import("./update/command.ts")).updateCommand(a, c),
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

/** Mentions a newer release the daemon has already seen; never hits the network. */
async function hintUpdate() {
  const latest = (await import("./update/release.ts")).newerRelease()
  if (!latest) return
  const [{ write }, { availableLine }] = await Promise.all([
    import("./ui/banner.ts"),
    import("./update/command.ts"),
  ])
  write(process.stderr, `${availableLine(latest)}\n`)
}

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv
  if (!name || name === "help" || name === "-h" || name === "--help") {
    const { write } = await import("./ui/banner.ts")
    write(process.stdout, await help())
    await hintUpdate()
    return 0
  }
  if (name === "version" || name === "-v" || name === "--version") {
    console.log(`senu ${version}`)
    await hintUpdate()
    return 0
  }

  const command = COMMANDS[name]
  if (!command) {
    console.error(`senu: unknown command "${name}"\n`)
    const { write } = await import("./ui/banner.ts")
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
