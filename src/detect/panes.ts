import { parseAgent, type Agent } from "./manifest.ts"

/**
 * Finding agent panes in tmux, shared by `scout`, `watch` and `agents`.
 * The daemon polls every second, so a poll costs a fixed number of processes
 * however many panes there are: one `list-panes`, at most one `ps`, and one
 * `tmux` call that captures every screen.
 */

export interface Pane {
  id: string
  /** The pane's shell. Its terminal's foreground process group is the agent's. */
  pid: number
  /** tmux's `pane_current_command`: the foreground process's name. */
  command: string
  /** tmux's `pane_title`, as tmux shows it. */
  title: string
  /** The title the agent set; `""` when tmux is still showing its default (the host name). */
  oscTitle: string
  active: boolean
  session: string
  sessionAttached: boolean
  windowId: string
  windowIndex: number
  windowName: string
  windowActive: boolean
  /** Last activity in the window, epoch seconds. */
  windowActivity: number
  /** The window's `@ai_state`, as the daemon last wrote it. */
  aiState: string
}

export interface AgentPane extends Pane {
  agent: Agent
}

const SEP = "\x1f"
const FIELDS = [
  "pane_id",
  "pane_pid",
  "pane_current_command",
  "pane_active",
  "session_name",
  "session_attached",
  "window_id",
  "window_index",
  "window_name",
  "window_active",
  "window_activity",
  "@ai_state",
  "host",
  "host_short",
  // free text last, so a stray separator in it can't shift the other fields
  "pane_title",
]
const FORMAT = FIELDS.map((f) => `#{${f}}`).join(SEP)

async function run(argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { ok: code === 0, out }
  } catch {
    return { ok: false, out: "" } // tmux or ps not installed
  }
}

let socketArgs: string[] = []

/**
 * Points every tmux call at another server: `["-L", name]` or `["-S", path]`.
 * Without one, tmux picks the server from `$TMUX`, as `run-shell` sets it.
 */
export function useTmuxSocket(args: string[]) {
  socketArgs = args
}

/** The picker's name for the same thing. */
export const setTmuxServer = useTmuxSocket

export const tmux = (...args: string[]) => run(["tmux", ...socketArgs, ...args])

/** Every pane in every session, in one `list-panes`. */
export async function listPanes(): Promise<Pane[]> {
  const { out } = await tmux("list-panes", "-a", "-F", FORMAT)
  const panes: Pane[] = []
  for (const line of out.split("\n")) {
    const f = line.split(SEP)
    if (f.length < FIELDS.length) continue
    const [id, pid, command, active, session, attached, windowId, windowIndex, windowName, windowActive, activity, aiState, host, hostShort] = f
    const title = f.slice(FIELDS.length - 1).join(SEP)
    panes.push({
      id: id!,
      pid: Number(pid),
      command: command!,
      title,
      // tmux titles a pane with the host name until something sets one; herdr would see no title
      oscTitle: title === host || title === hostShort ? "" : title,
      active: active === "1",
      session: session!,
      sessionAttached: attached !== "" && attached !== "0",
      windowId: windowId!,
      windowIndex: Number(windowIndex),
      windowName: windowName!,
      windowActive: windowActive === "1",
      windowActivity: Number(activity),
      aiState: aiState!,
    })
  }
  return panes
}

/** Claude's native binary runs as its version, e.g. `2.1.280`, so tmux reports that as the command. */
const VERSION_COMMAND = /^\d+\.\d+/

const RUNTIMES = new Set(["node", "bun", "deno", "sh", "bash", "zsh", "fish"])
const isRuntime = (name: string) => RUNTIMES.has(name) || /^python(\d+(\.\d+)*)?$/.test(name)
/** Flags after which the runtime runs inline code or a module, not a script file. */
const EVAL_FLAGS = ["-e", "--eval", "-p", "--print", "-c", "-m"]

/** `-e`, `-ecode` or `--eval=code`: herdr's short-payload and long-value forms. */
const isEvalFlag = (arg: string) =>
  EVAL_FLAGS.some((f) => arg === f || (f.startsWith("--") ? arg.startsWith(`${f}=`) : !arg.startsWith("--") && arg.startsWith(f)))
/** Runtime flags that take the next argument as their value. */
const VALUE_FLAGS = new Set(["-r", "--require", "--loader", "--import", "--experimental-loader", "--inspect-port", "-W", "-X", "-S", "-L", "-o"])

/** A path's basename, lowercased, without a script or Windows suffix, as herdr normalises it. */
function baseName(token: string): string {
  const base = token.replace(/^["']+|["']+$/g, "").split(/[/\\]/).filter(Boolean).pop() ?? ""
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|js)$/, "")
}

/**
 * The agent a process is, from its argv the way herdr reads it: argv0, or for
 * a runtime like `node …/bin/codex`, the script it runs. Inline code
 * (`node -e`, `sh -c`) is never taken for an agent.
 */
export function agentFromArgv(argv: string[]): Agent | null {
  const [argv0, ...rest] = argv
  if (!argv0) return null
  const name = baseName(argv0.replace(/^-/, "")) // a login shell's argv0 is `-zsh`
  const direct = parseAgent(name)
  if (direct) return direct
  if (!isRuntime(name)) return null

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === "--") return rest[i + 1] ? parseAgent(baseName(rest[i + 1]!)) : null
    if (isEvalFlag(arg)) return null
    if (arg.startsWith("-")) {
      if (VALUE_FLAGS.has(arg)) i++
      continue
    }
    return parseAgent(baseName(arg))
  }
  return null
}

interface Proc {
  pid: number
  pgid: number
  tpgid: number
  argv: string[]
}

/** One `ps` for the whole machine. `args` is space-joined, so a path with spaces splits; herdr reads /proc and doesn't have that problem. */
async function processTable(): Promise<Proc[]> {
  const { ok, out } = await run(["ps", "-ax", "-o", "pid=,pgid=,tpgid=,args="])
  if (!ok) return []
  const procs: Proc[] = []
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(line)
    if (m) procs.push({ pid: Number(m[1]), pgid: Number(m[2]), tpgid: Number(m[3]), argv: m[4]!.trim().split(/\s+/) })
  }
  return procs
}

/** The agent in the pane's foreground process group: its leader first, then any member. */
function agentInForeground(pane: Pane, procs: Proc[]): Agent | null {
  const shell = procs.find((p) => p.pid === pane.pid)
  if (!shell || shell.tpgid <= 0) return null
  const group = procs.filter((p) => p.pgid === shell.tpgid)
  const leader = group.find((p) => p.pid === shell.tpgid)
  for (const p of leader ? [leader, ...group.filter((g) => g !== leader)] : group) {
    const agent = agentFromArgv(p.argv)
    if (agent) return agent
  }
  return null
}

/** Worth a `ps` lookup: a runtime that might be running an agent script, or Claude's versioned binary. */
const needsArgv = (command: string) => isRuntime(baseName(command)) || VERSION_COMMAND.test(command)

/**
 * Picks out the panes running an agent. The command name settles most panes;
 * the rest (`node`, `bun`, a version number) cost one `ps` between them.
 */
export async function identifyAgents(panes: Pane[]): Promise<AgentPane[]> {
  const direct = (p: Pane) => parseAgent(baseName(p.command))
  const procs = panes.some((p) => !direct(p) && needsArgv(p.command)) ? await processTable() : []

  const found: AgentPane[] = []
  for (const p of panes) {
    let agent = direct(p)
    if (!agent && needsArgv(p.command)) {
      agent = agentInForeground(p, procs)
      // without ps, a version-number command is still almost certainly Claude
      if (!agent && !procs.length && VERSION_COMMAND.test(p.command)) agent = "claude"
    }
    if (agent) found.push({ ...p, agent })
  }
  return found
}

/** `listPanes` then `identifyAgents`. */
export async function listAgentPanes(): Promise<AgentPane[]> {
  return identifyAgents(await listPanes())
}

/**
 * The visible screen of each pane, which is what herdr's engine reads.
 * `history` adds that many scrollback lines above it (the picker's Codex label
 * wants more), but classifying should use 0: rules anchor on the screen's top.
 */
export async function capturePanes(ids: string[], history = 0): Promise<Map<string, string>> {
  const screens = new Map<string, string>()
  if (!ids.length) return screens

  const capture = (id: string) => ["capture-pane", "-p", "-t", id, ...(history > 0 ? ["-S", `-${history}`] : [])]
  // one tmux call: a marker line, then the screen, per pane
  const args: string[] = []
  for (const id of ids) args.push(...(args.length ? [";"] : []), "display-message", "-p", "-t", id, `${SEP}senu ${id}${SEP}`, ";", ...capture(id))
  const { out } = await tmux(...args)

  const parts = out.split(new RegExp(`^${SEP}senu (%\\d+)${SEP}\\n`, "m"))
  for (let i = 1; i + 1 < parts.length; i += 2) screens.set(parts[i]!, parts[i + 1]!)

  // tmux stops at the first failing command, so a pane that closed mid-poll hides the rest
  const missing = ids.filter((id) => !screens.has(id))
  if (missing.length) {
    const rest = await Promise.all(missing.map(async (id) => [id, await tmux(...capture(id))] as const))
    for (const [id, r] of rest) if (r.ok) screens.set(id, r.out)
  }
  return screens
}

export async function capturePane(id: string, history = 0): Promise<string | null> {
  const { ok, out } = await tmux("capture-pane", "-p", "-t", id, ...(history > 0 ? ["-S", `-${history}`] : []))
  return ok ? out : null
}

/** The pane a tmux target (`%8`, `senu:2`, `senu:2.1`) names, or null if there's none. */
export async function findPane(target: string): Promise<Pane | null> {
  const { ok, out } = await tmux("display-message", "-p", "-t", target, "#{pane_id}")
  if (!ok) return null
  const id = out.trim()
  return (await listPanes()).find((p) => p.id === id) ?? null
}
