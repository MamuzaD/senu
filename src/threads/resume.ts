import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

import { opencodeHome, type ThreadsConfig } from "~/config.ts"
import { tmux } from "~/detect/panes.ts"
import { home } from "~/paths.ts"

import type { Thread } from "./thread.ts"

export interface Launch {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

// Always set CODEX_HOME so an exported one can't win. Setting CLAUDE_CONFIG_DIR, even to ~/.claude,
// switches Claude's login, so ~/.claude threads unset an exported one instead.
export function launchFor(t: Pick<Thread, "agent" | "sessionId" | "cwd" | "home">): Launch {
  if (t.agent === "codex")
    return { argv: ["codex", "resume", t.sessionId], cwd: t.cwd, env: { CODEX_HOME: t.home } }
  // OpenCode's shared background service reads its own data directory and ignores the client's
  // XDG_DATA_HOME, so another profile's session needs a private server.
  if (t.agent === "opencode") {
    const standalone = t.home === opencodeHome() ? [] : ["--standalone"]
    return {
      argv: ["opencode", ...standalone, "--session", t.sessionId],
      cwd: t.cwd,
      env: { XDG_DATA_HOME: dirname(t.home) },
    }
  }
  const claude = ["claude", "--resume", t.sessionId]
  return t.home === join(home, ".claude")
    ? { argv: ["env", "-u", "CLAUDE_CONFIG_DIR", ...claude], cwd: t.cwd, env: {} }
    : { argv: claude, cwd: t.cwd, env: { CLAUDE_CONFIG_DIR: t.home } }
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

export async function resume(t: Thread, mode: ThreadsConfig["resume"]): Promise<number> {
  const launch = launchFor(t)
  if (!existsSync(launch.cwd)) throw new ResumeError(`${launch.cwd} no longer exists`)
  // A popup is a throwaway, so the thread gets its own window, as it does when resume = "window";
  // tmux gives a popup TMUX but no TMUX_PANE
  const window = process.env.TMUX && (mode === "window" || !process.env.TMUX_PANE)
  return window ? openWindow(launch) : runHere(launch)
}
