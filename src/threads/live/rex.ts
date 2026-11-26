import { basename, join } from "node:path"

import type { Agent } from "~/detect/manifest.ts"
import { agentFromProcess, processArgv, run } from "~/detect/panes.ts"

import type { Launch } from "../resume.ts"
import { runningThreads } from "../running.ts"
import { attentionOf, titleTask, type Attention, type PaneRow } from "./collect.ts"
import type { Mux } from "./mux.ts"

/** tmux started inside a Rex block inherits REX_BLOCK, so tmux wins. */
export const inRex = () => !process.env.TMUX && !!process.env.REX_BLOCK

// Popups don't get a login shell's PATH
const rex = () => join(process.env.REX_BIN_DIR ?? "", "rex")

type Host = string | null

const rexOn = (host: Host) => [
  rex(),
  "--autostart=false",
  ...(host ? ["--timeout", "3s", "-S", host] : []),
]

async function call<T>(method: string, args: object = {}, host: Host = null): Promise<T | null> {
  const { ok, out } = await run([...rexOn(host), "api", "call", method, JSON.stringify(args)])
  return ok ? (JSON.parse(out) as T) : null
}

interface View {
  session_id: string | null
  label?: string
  windows?:
    | {
        window_id: string | null
        focused_block_id?: string | null
        layers:
          | {
              kind: string
              blocks: { block_id: string | null; flavor?: string; owner?: string }[] | null
            }[]
          | null
      }[]
    | null
}

/** Rex's block ids don't say which session they're in, and every call needs both. */
export const paneId = (sessionId: string, blockId: string, host: Host = null) =>
  `${host ? `${host}//` : ""}${sessionId}/${blockId}`
const parts = (id: string) => {
  const cut = id.lastIndexOf("//")
  const [session_id, block_id] = id.slice(cut < 0 ? 0 : cut + 2).split("/")
  return {
    host: cut < 0 ? null : id.slice(0, cut),
    target: { session_id: session_id!, block_id: block_id! },
  }
}

export function terminalsIn(view: View, host: Host = null) {
  const sessionId = view.session_id
  if (!sessionId) return []
  return (view.windows ?? []).flatMap((w, i) =>
    (w.layers ?? []).flatMap((l) =>
      (l.blocks ?? []).flatMap((b) =>
        b.block_id && w.window_id && b.flavor?.startsWith("com.superlogical.terminal.")
          ? [
              {
                sessionId,
                blockId: b.block_id,
                host,
                id: paneId(sessionId, b.block_id, host),
                session: view.label ?? "",
                windowId: w.window_id,
                // Rex numbers tabs from 1
                windowIndex: i + 1,
                active: w.focused_block_id === b.block_id,
              },
            ]
          : [],
      ),
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
  host: Host
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
    call<T>(
      `com.superlogical.terminal.${method}`,
      { session_id: t.sessionId, block_id: t.blockId, args: {} },
      t.host,
    )
  const proc = await on<{
    child?: { pid: number } | null
    foreground: {
      pid: number
      name: string
      path?: string
      cwd?: string
      invoked_path?: string | null
      script?: string | null
    } | null
  }>("process")
  if (!proc?.foreground || !proc.child) return null
  const { pid, name, path, cwd, invoked_path, script } = proc.foreground
  const argv = t.host
    ? () => [invoked_path, script].filter((a): a is string => !!a)
    : () => processArgv(pid)
  const agent = agentFromProcess(path ?? name, argv)
  if (!agent) return null
  const [status, title] = await Promise.all([
    on<{ records: ProgramRecord[] | null }>("program_status"),
    on<{ title: string }>("title"),
  ])
  return {
    id: t.id,
    host: t.host,
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

const instanceId = async (host: Host) =>
  (await call<{ instance_id?: string }>("server.status", {}, host).catch(() => null))?.instance_id

/** `rex hosts` can list this machine, or one machine twice, under another label. */
async function discoverHosts(): Promise<string[]> {
  const { ok, out } = await run([...rexOn(null), "hosts", "list", "--json"])
  if (!ok) return []
  const labels = ((JSON.parse(out) as { hosts?: { host?: { label?: string } }[] }).hosts ?? [])
    .map((h) => h.host?.label)
    .filter((l): l is string => !!l)
  const [me, ...ids] = await Promise.all([instanceId(null), ...labels.map(instanceId)])
  const seen = new Set([me])
  return labels.filter((_, i) => {
    const id = ids[i]
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

let hostsOnce: Promise<string[]> | undefined
const otherHosts = () => (hostsOnce ??= discoverHosts())

/** The running agents in every session. A block that closes while this runs is left out. */
async function agentsOn(host: Host): Promise<RexAgent[]> {
  const list = await call<{ sessions: { session_id: string }[] | null }>("session.list", {}, host)
  const views = await Promise.all(
    (list?.sessions ?? []).map((s) =>
      call<View>("session.view", { session_id: s.session_id }, host),
    ),
  )
  const agents = await Promise.all(
    views.flatMap((v) => (v ? terminalsIn(v, host) : [])).map(agentIn),
  )
  return agents.filter((a) => a !== null)
}

const remoteAgents = async () =>
  (await Promise.all((await otherHosts()).map((host) => agentsOn(host).catch(() => [])))).flat()

const REMOTE_MS = 5000

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
    // An agent that hasn't reported yet is at least running now
    activity: (a.record?.updated_at ? Date.parse(a.record.updated_at) : Date.now()) / 1000,
    label: a.record?.msg || titleTask(a.title, a.agent, a.session) || basename(a.cwd),
    host: a.host ?? undefined,
    source: "watch",
    active: a.active,
  }
}

/**
 * The session holding this terminal. Terminals only get REX_BLOCK, and the API wants a session
 * id, so the CLI resolves it.
 */
async function here(): Promise<View | null> {
  const block = process.env.REX_BLOCK
  if (!block) return null
  const { ok, out } = await run([rex(), "--autostart=false", "session", "inspect", block, "--json"])
  return ok ? (JSON.parse(out) as View) : null
}

async function appClients(host: Host, sessionId?: string) {
  const list = await call<{
    clients:
      | {
          client_id: string
          info?: { kind?: string; label?: string }
          connection_state?: string
        }[]
      | null
  }>("client.list", { kinds: ["app"], session_id: sessionId }, host)
  return (list?.clients ?? []).filter(
    (c) => c.info?.kind === "app" && c.connection_state !== "lost",
  )
}

async function attachedApp(sessionId: string) {
  const apps = await appClients(null, sessionId)
  return apps.length === 1 ? apps[0]!.client_id : null
}

async function sourceAppLabel(client: string | undefined) {
  const local = await appClients(null).catch(() => [])
  const labelOn = (apps: typeof local, id: string | undefined) => {
    const label = apps.find((app) => app.client_id === id)?.info?.label
    return label && apps.filter((app) => app.info?.label === label).length === 1 ? label : undefined
  }
  if (!client) {
    const session = await here()
    const owner = session?.windows
      ?.flatMap((w) => w.layers?.flatMap((layer) => layer.blocks ?? []) ?? [])
      .find((block) => block.block_id === process.env.REX_BLOCK)?.owner
    if (owner) return labelOn(local, owner)
    const attached = session?.session_id ? await appClients(null, session.session_id) : []
    const apps = attached.length ? attached : local
    return apps.length === 1 ? labelOn(local, apps[0]?.client_id) : undefined
  }
  if (!client.startsWith("client:"))
    return local.filter((app) => app.info?.label === client).length === 1 ? client : undefined
  if (local.some((app) => app.client_id === client)) return labelOn(local, client)
  const peers = await otherHosts().catch(() => [])
  const labels = await Promise.all(
    peers.map(async (host) => labelOn(await appClients(host).catch(() => []), client)),
  )
  const matched = labels.filter(Boolean)
  return matched.length === 1 ? matched[0] : undefined
}

export async function rexJumpClient(id: string) {
  const { host } = parts(id)
  if (!host) return null
  const apps = await appClients(host)
  const client = process.env.REX_CLIENT
  const exact = apps.find((app) => app.client_id === client)
  if (exact)
    return { id: exact.client_id, label: exact.info?.label || exact.client_id, confirm: false }
  const label = await sourceAppLabel(client).catch(() => undefined)
  const matches = label ? apps.filter((app) => app.info?.label === label) : []
  const app = matches.length === 1 ? matches[0] : apps.length === 1 ? apps[0] : undefined
  if (!app) return null
  return {
    id: app.client_id,
    label: app.info?.label || app.client_id,
    confirm: matches.length !== 1,
  }
}

/** Server focus alone doesn't select the tab in the app, even within the same session. */
export async function rexJump(
  id: string,
  windowId: string,
  confirmedClient?: string,
): Promise<"ok" | "gone" | "unselected" | "ambiguous" | "remote-client"> {
  const { host, target } = parts(id)
  const client = confirmedClient ?? process.env.REX_CLIENT
  const destination =
    host && client
      ? (await appClients(host).catch(() => [])).find((app) => app.client_id === client)
      : undefined
  if (host && !destination) return "remote-client"
  if ((await call("session.focus_block", target, host)) === null) return "gone"
  const select = (selector?: string) =>
    run([
      ...rexOn(host),
      ...(selector ? ["-C", selector] : []),
      "do",
      "session.select",
      `session_id=${target.session_id}`,
      `window_id=${windowId}`,
    ])
  if ((await select(destination?.client_id)).ok) return "ok"
  if (host) return "unselected"
  const app = await attachedApp((await here())?.session_id ?? target.session_id)
  if (!app) return client ? "unselected" : "ambiguous"
  return (await select(app)).ok ? "ok" : "unselected"
}

const rexKill = async (id: string) => {
  const { host, target } = parts(id)
  return (await call("block.close", target, host)) !== null
}

export function floating(view: View, blockId: string): boolean {
  return (view.windows ?? []).some((w) =>
    (w.layers ?? []).some(
      (l) => l.kind === "floating" && (l.blocks ?? []).some((b) => b.block_id === blockId),
    ),
  )
}

async function rexInPopup(): Promise<boolean> {
  const view = await here()
  return !!view && floating(view, process.env.REX_BLOCK ?? "")
}

export function rexRunArgs(launch: Launch, sessionId: string): string[] {
  const env = Object.entries(launch.env).map(([k, v]) => `${k}=${v}`)
  const argv = env.length ? ["env", ...env, ...launch.argv] : launch.argv
  // Agents are often only on the interactive shell's PATH, as opencode's installer sets it up
  return ["run", "--json", "--interactive", "-s", sessionId, "-c", launch.cwd, "--", ...argv]
}

export async function rexOpenWindow(launch: Launch): Promise<boolean> {
  const sessionId = (await here())?.session_id
  if (!sessionId) return false
  const { ok, out } = await run([rex(), "--autostart=false", ...rexRunArgs(launch, sessionId)])
  if (!ok) return false
  // The agent is already running, so a tab the app can't select still counts; failing here
  // would make a retry start a second copy
  const created = JSON.parse(out) as { window_id: string; block_ids: string[] }
  const blockId = created.block_ids[0]
  if (blockId) await rexJump(paneId(sessionId, blockId), created.window_id)
  return true
}

export const rexMux: Mux = {
  name: "rex",
  collector: () => {
    let remote: RexAgent[] = []
    let remoteAt = 0
    let fetching = false
    return {
      async collect() {
        if (!fetching && Date.now() - remoteAt > REMOTE_MS) {
          fetching = true
          void remoteAgents()
            .then(
              (agents) => {
                remote = agents
              },
              () => {
                remote = []
              },
            )
            .finally(() => {
              remoteAt = Date.now()
              fetching = false
            })
        }
        const agents = [...(await agentsOn(null)), ...remote]
        return { rows: agents.map(rexRow), panes: agents, daemon: "unknown" }
      },
    }
  },

  async seen(profiles) {
    const agents = await agentsOn(null)
    return {
      panes: agents,
      rows: agents.map(rexRow),
      ...(await runningThreads(
        profiles,
        agents.map((a) => ({
          id: a.id,
          pid: a.pid,
          cwd: a.cwd,
          session: a.session,
          oscTitle: a.title,
        })),
      )),
    }
  },

  async jump(live, opts) {
    const jumped = await rexJump(live.paneId, live.windowId, opts.rexClientId)
    if (jumped === "ok") return null
    if (jumped === "gone") return "no longer running"
    if (jumped === "remote-client") return "Rex couldn't identify this app on the destination host"
    return jumped === "ambiguous"
      ? "Rex can't tell which device to switch; open senu from its popup"
      : "not reachable: is Remote Control on in Rex Settings > Server > Client Info?"
  },

  kill: rexKill,

  resumesInWindow: async (mode) => mode === "window" || (await rexInPopup()),

  openWindow: async (launch) => ((await rexOpenWindow(launch)) ? null : "Rex could not open a tab"),
}
