import type { Config } from "../config.ts"
import { setTmuxServer, tmux } from "../detect/panes.ts"
import { Collector } from "./collect.ts"
import { runPicker } from "./picker.tsx"

const HELP = `usage: senu agents [-L socket-name | -S socket-path]

Lists every agent window across all tmux sessions, the ones that need you
first, and jumps to the one you pick. Meant for a tmux popup (prefix+a).

  j/k ↑/↓  move          ⏎    jump to the agent
  g/G      first / last  x/d  kill it (asks first)
  r        refresh       q    quit

-L and -S pick the tmux server as tmux's own flags do; by default it's the
one $TMUX names.
`

export async function agentsCommand(args: string[], config: Config): Promise<number> {
  const server: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "-h" || a === "--help") {
      process.stdout.write(HELP)
      return 0
    }
    if ((a === "-L" || a === "-S") && args[i + 1]) server.push(a, args[++i]!)
    else {
      process.stderr.write(HELP)
      return 2
    }
  }
  setTmuxServer(server)

  if (!(await tmux("info")).ok) {
    console.error("senu agents: no tmux server")
    return 1
  }
  return runPicker(new Collector(), { raiseGhosttyTab: config.agents.raiseGhosttyTab })
}
