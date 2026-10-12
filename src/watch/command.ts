import type { Config } from "~/config.ts"
import { setTmuxSocket } from "~/detect/panes.ts"
import { printHelp } from "~/ui/help.ts"

import { runDaemon, Watcher } from "./daemon.ts"
import { play, resolveSound } from "./sounds.ts"
import type { SoundKind } from "./state.ts"

const HELP = `usage: senu watch [-L socket | -S path]
       senu watch once [-L socket | -S path]
       senu watch test [done|request]

Sets each window's @ai_state about once a second, and chimes when an agent needs you.

  once    poll once and print each window's state
  test    play the done and request sounds, or the one named
  -L, -S  the tmux server, as in tmux
`

const KINDS = new Set<SoundKind>(["done", "request"])

async function testSounds(args: string[], config: Config): Promise<number> {
  const kinds = args.length ? args : ["request", "done"]
  for (const k of kinds) {
    if (!KINDS.has(k as SoundKind)) {
      console.error(`senu watch test: unknown sound "${k}" (have done, request)`)
      return 2
    }
  }
  let failed = false
  for (const kind of kinds as SoundKind[]) {
    const path = resolveSound(kind, config.sound[kind])
    console.log(`${kind.padEnd(8)} -> ${path ?? "none"}`)
    const proc = path ? play(path) : null
    // Play one at a time so each sound is heard on its own.
    if (!proc || (await proc.exited) !== 0) {
      console.error(
        `senu watch test: could not play ${kind} (check the sound file and installed audio player)`,
      )
      failed = true
    }
  }
  return failed ? 1 : 0
}

async function once(): Promise<number> {
  const watcher = new Watcher()
  if (!(await watcher.tick(true, Date.now(), true))) {
    console.error("senu watch once: no tmux server, or no panes")
    return 1
  }
  const { panes, windows } = watcher.snapshot()
  for (const [id, t] of windows) console.log(`window ${id}  ${t.raw}`)
  for (const [id, t] of panes) console.log(`  pane ${id}  ${t.state ?? "(no state yet)"}`)
  if (!windows.size) console.log("no agent panes")
  return 0
}

export async function watchCommand(argv: string[], config: Config): Promise<number> {
  const args = [...argv]
  if (args.includes("-h") || args.includes("--help")) {
    await printHelp(process.stdout, HELP)
    return 0
  }
  for (const flag of ["-L", "-S"]) {
    const i = args.indexOf(flag)
    if (i < 0) continue
    const value = args[i + 1]
    if (!value) {
      console.error(`senu watch: ${flag} needs a value`)
      return 2
    }
    setTmuxSocket([flag, value])
    args.splice(i, 2)
  }

  const [sub, ...rest] = args
  if (sub === "test") return testSounds(rest, config)
  if (sub === "once" && !rest.length) return once()
  if (sub === undefined) return runDaemon()
  await printHelp(process.stderr, HELP)
  return 2
}
