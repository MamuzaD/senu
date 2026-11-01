import { basename, join } from "node:path"

import type { Agent } from "~/detect/manifest.ts"
import { agentFromProcess, processArgv, run } from "~/detect/panes.ts"

import type { Launch } from "../resume.ts"
import { attentionOf, titleTask, type Attention, type Collected, type PaneRow } from "./collect.ts"

/** tmux started inside a Rex block inherits REX_SESSION, so tmux wins. */
export const inRex = () => !process.env.TMUX && !!process.env.REX_SESSION

// Popups don't get a login shell's PATH
const rex = () => join(process.env.REX_BIN_DIR ?? "", "rex")

async function call<T>(method: string, args: object = {}): Promise<T | null> {
  const { ok, out } = await run([
    rex(),
    "--autostart=false",
    "api",
    "call",
    method,
    JSON.stringify(args),
  ])
  return ok ? (JSON.parse(out) as T) : null
}

interface View {
  session_id: string
  label: string
  windows: {
    window_id: string
    focused_block_id: string
    layers: { kind: string; blocks: { block_id: string; flavor: string }[] }[]
  }[]
}

/** Rex's block ids don't say which session they're in, and every call needs both. */
export const paneId = (sessionId: string, blockId: string) => `${sessionId}/${blockId}`
const parts = (id: string) => {
  const [session_id, block_id] = id.split("/")
  return { session_id: session_id!, block_id: block_id! }
}

export function terminalsIn(view: View) {
  return view.windows.flatMap((w, i) =>
    w.layers.flatMap((l) =>
      l.blocks
        .filter((b) => b.flavor.startsWith("com.superlogical.terminal."))
        .map((b) => ({
          sessionId: view.session_id,
          blockId: b.block_id,
          id: paneId(view.session_id, b.block_id),
          session: view.label,
          windowId: w.window_id,
          // Rex numbers tabs from 1
          windowIndex: i + 1,
          active: w.focused_block_id === b.block_id,
        })),
    ),
  )
}

interface ProgramRecord {
  id?: string
  state?: string
  msg?: string
  updated_at?: string
}

export interface RexAgent {
  id: string
  /** The block's first process, like tmux's pane_pid. */
  pid: number
  agent: Agent
  session: string
  windowId: string
  windowIndex: number
  active: boolean
  cwd: string
  title: string
  /** The agent's own report; a block has none until the agent sends one. */
  record: ProgramRecord | null
}

async function agentIn(t: ReturnType<typeof terminalsIn>[number]): Promise<RexAgent | null> {
  const on = <T>(method: string) =>
    call<T>(`com.superlogical.terminal.${method}`, {
      session_id: t.sessionId,
      block_id: t.blockId,
      args: {},
    })
  const proc = await on<{
    child: { pid: number }
    foreground: { pid: number; name: string; path?: string; cwd?: string } | null
  }>("process")
  if (!proc?.foreground) return null
  const { pid, name, path, cwd } = proc.foreground
  const agent = agentFromProcess(path ?? name, () => processArgv(pid))
  if (!agent) return null
  const [status, title] = await Promise.all([
    on<{ records: ProgramRecord[] | null }>("program_status"),
    on<{ title: string }>("title"),
  ])
  return {
    id: t.id,
    pid: proc.child.pid,
    agent,
    session: t.session,
    windowId: t.windowId,
    windowIndex: t.windowIndex,
    active: t.active,
    cwd: cwd ?? "",
    title: title?.title ?? "",
    record: status?.records?.find((r) => !r.id) ?? null,
  }
}

/** The running agents in every session. A block that closes while this runs is left out. */
export async function rexAgents(): Promise<RexAgent[]> {
  const list = await call<{ sessions: { session_id: string }[] | null }>("session.list")
  const views = await Promise.all(
    (list?.sessions ?? []).map((s) => call<View>("session.view", { session_id: s.session_id })),
  )
  const agents = await Promise.all(views.flatMap((v) => (v ? terminalsIn(v) : [])).map(agentIn))
  return agents.filter((a) => a !== null)
}

const attention = (state: string | undefined): Attention =>
  state === "error" ? "done" : (attentionOf(state ?? "") ?? "idle")

export function rexRow(a: RexAgent): PaneRow {
  return {
    windowId: a.windowId,
    session: a.session,
    windowIndex: a.windowIndex,
    windowName: "",
    paneId: a.id,
    agent: a.agent,
    state: attention(a.record?.state),
    activity: a.record?.updated_at ? Date.parse(a.record.updated_at) / 1000 : 0,
    label: a.record?.msg || titleTask(a.title, a.agent, a.session) || basename(a.cwd),
    source: "watch",
    active: a.active,
  }
}

export class RexCollector {
  async collect(): Promise<Collected> {
    const agents = await rexAgents()
    return { rows: agents.map(rexRow), panes: agents, daemon: "unknown" }
  }
}

/** Selecting another session goes through the Rex app, which needs Remote Control on. */
export async function rexJump(id: string, windowId: string): Promise<boolean> {
  const target = parts(id)
  if (target.session_id !== process.env.REX_SESSION) {
    const select = [`session_id=${target.session_id}`, `window_id=${windowId}`]
    if (!(await run([rex(), "do", "session.select", ...select])).ok) return false
  }
  return (await call("session.focus_block", target)) !== null
}

export const rexKill = async (id: string) => (await call("block.close", parts(id))) !== null

export function floating(view: View, blockId: string): boolean {
  return view.windows.some((w) =>
    w.layers.some((l) => l.kind === "floating" && l.blocks.some((b) => b.block_id === blockId)),
  )
}

export async function rexInPopup(): Promise<boolean> {
  const view = await call<View>("session.view", { session_id: process.env.REX_SESSION })
  return !!view && floating(view, process.env.REX_BLOCK ?? "")
}

export function rexRunArgs(launch: Launch, sessionId: string): string[] {
  const env = Object.entries(launch.env).map(([k, v]) => `${k}=${v}`)
  const argv = env.length ? ["env", ...env, ...launch.argv] : launch.argv
  return ["run", "-s", sessionId, "-c", launch.cwd, "--", ...argv]
}

export async function rexOpenWindow(launch: Launch): Promise<boolean> {
  return (await run([rex(), ...rexRunArgs(launch, process.env.REX_SESSION ?? "")])).ok
}
