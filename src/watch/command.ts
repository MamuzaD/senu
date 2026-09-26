import type { Config } from "../config.ts"
import { useTmuxSocket } from "../detect/panes.ts"
import { runDaemon, Watcher } from "./daemon.ts"
import { play, resolveSound } from "./sounds.ts"
import type { SoundKind } from "./state.ts"

const HELP = `usage: senu watch [-L socket-name | -S socket-path]
       senu watch once [-L … | -S …]
       senu watch test [done|request]

watch runs the daemon: it classifies every agent pane about once a second,
writes each window's @ai_state (working, blocked, done or idle) and chimes when
a background agent finishes or needs you. A second start on the same tmux
server does nothing, so tmux.conf can run it on every reload.

once polls a single time and prints each window's state, changing nothing.
test plays the done and request sounds (or just the one named).
-L and -S pick the tmux server, as they do for tmux itself.
`

const KINDS: SoundKind[] = ["done", "request"]

async function testSounds(args: string[], config: Config): Promise<number> {
  const kinds = args.length ? args : ["request", "done"]
  for (const k of kinds) {
    if (!KINDS.includes(k as SoundKind)) {
      console.error(`senu watch test: unknown sound "${k}" (have done, request)`)
      return 2
    }
  }
  let failed = false
  for (const kind of kinds as SoundKind[]) {
    const path = resolveSound(kind, config.sound[kind])
    console.log(`${kind.padEnd(8)} -> ${path ?? "none"}`)
    const proc = path ? play(path) : null
    if (!proc || await proc.exited !== 0) {
      console.error(`senu watch test: could not play ${kind} (check the sound file and installed audio player)`)
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
    process.stdout.write(HELP)
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
    useTmuxSocket([flag, value])
    args.splice(i, 2)
  }

  const [sub, ...rest] = args
  if (sub === "test") return testSounds(rest, config)
  if (sub === "once" && !rest.length) return once()
  if (sub === undefined) return runDaemon()
  process.stderr.write(HELP)
  return 2
}
