import { existsSync } from "node:fs"
import { join } from "node:path"

import { tmux } from "~/detect/panes.ts"
import { home } from "~/paths.ts"

import type { Thread } from "./thread.ts"

export interface Launch {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

// Always set CODEX_HOME so an exported one can't win; CLAUDE_CONFIG_DIR, even ~/.claude, switches Claude's login
export function launchFor(t: Pick<Thread, "agent" | "sessionId" | "cwd" | "home">): Launch {
  if (t.agent === "codex")
    return { argv: ["codex", "resume", t.sessionId], cwd: t.cwd, env: { CODEX_HOME: t.home } }
  return {
    argv: ["claude", "--resume", t.sessionId],
    cwd: t.cwd,
    env: t.home === join(home, ".claude") ? {} : { CLAUDE_CONFIG_DIR: t.home },
  }
}

export class ResumeError extends Error {}

async function openWindow(launch: Launch): Promise<number> {
  const env = Object.entries(launch.env).flatMap(([k, v]) => ["-e", `${k}=${v}`])
  const { ok } = await tmux("new-window", "-c", launch.cwd, ...env, "--", ...launch.argv)
  if (!ok) throw new ResumeError("tmux could not open a window")
  return 0
}

function runHere(launch: Launch): Promise<number> {
  return Bun.spawn(launch.argv, {
    cwd: launch.cwd,
    env: { ...process.env, ...launch.env },
    stdio: ["inherit", "inherit", "inherit"],
  }).exited
}

export async function resume(t: Thread): Promise<number> {
  const launch = launchFor(t)
  if (!existsSync(launch.cwd)) throw new ResumeError(`${launch.cwd} no longer exists`)
  return process.env.TMUX ? openWindow(launch) : runHere(launch)
}
