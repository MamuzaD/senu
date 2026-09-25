import { tmux } from "../detect/panes.ts"
import type { AgentRow } from "./collect.ts"
import { raiseGhosttyTab } from "./ghostty.ts"

/** A tmux client: a terminal attached to a session. */
export interface Client {
  name: string
  session: string
  termname: string
}

const SEP = "\x1f"

async function clients(): Promise<Client[]> {
  const { out } = await tmux("list-clients", "-F", ["#{client_name}", "#{session_name}", "#{client_termname}"].join(SEP))
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", session = "", termname = ""] = line.split(SEP)
      return { name, session, termname }
    })
}

/** The client the picker's popup belongs to; null outside a client (a detached run). */
async function currentClient(): Promise<string | null> {
  if (!process.env.TMUX) return null
  const { ok, out } = await tmux("display-message", "-p", "#{client_name}")
  return ok && out.trim() ? out.trim() : null
}

/**
 * How to get to an agent:
 * - `here`: its session is the one you're in, so just select the window.
 * - `raise`: its session is showing in another Ghostty tab, so raise that tab
 *   and point it at the window, rather than pulling the session into this tab.
 * - `switch`: switch this client to the session and window (the python
 *   picker's switch-client, and the fallback when raising fails).
 */
export type JumpPlan = "here" | "raise" | "switch"

export function planJump(
  row: Pick<AgentRow, "session">,
  all: Client[],
  current: string | null,
  opts: { raiseGhosttyTab: boolean; platform: string },
): JumpPlan {
  const mine = all.find((c) => c.name === current)
  if (mine && mine.session === row.session) return "here"
  if (!opts.raiseGhosttyTab || opts.platform !== "darwin") return "switch"
  const elsewhere = all.some((c) => c.name !== current && c.session === row.session && /ghostty/i.test(c.termname))
  return elsewhere ? "raise" : "switch"
}

/** Jump to the agent's window. Resolves once tmux (and Ghostty) have done it. */
export async function jump(row: AgentRow, opts: { raiseGhosttyTab: boolean }): Promise<JumpPlan> {
  const [all, current] = await Promise.all([clients(), currentClient()])
  let plan = planJump(row, all, current, { ...opts, platform: process.platform })
  if (plan === "raise" && !(await raiseGhosttyTab(row.session))) plan = "switch"

  const client = current ? ["-c", current] : []
  if (plan === "switch") {
    // select the window first, so the client lands on it rather than flashing the session's last one
    await tmux("select-window", "-t", row.windowId, ";", "switch-client", ...client, "-t", row.windowId)
  } else {
    await tmux("select-window", "-t", row.windowId)
  }
  return plan
}

/** Kill the agent's pane; tmux closes the window with it if it was the last one. */
export async function kill(row: AgentRow): Promise<boolean> {
  return (await tmux("kill-pane", "-t", row.paneId)).ok
}
