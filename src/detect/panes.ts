import { dlopen, FFIType, ptr } from "bun:ffi"
import { readFileSync } from "node:fs"

import { parseAgent, type Agent } from "./manifest.ts"

export interface Pane {
  id: string
  /** tmux's pane_pid: the initial process, usually a shell; used to find the terminal's foreground group. */
  pid: number
  /** tmux's `pane_current_command`: the foreground process's name. */
  command: string
  /** tmux's `pane_title`, as tmux shows it. */
  title: string
  /** The title the agent set; `""` when tmux is still showing its default (the host name). */
  oscTitle: string
  active: boolean
  /** tmux's `pane_dead`: its process exited, and remain-on-exit is keeping the pane. */
  dead: boolean
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

/**
 * Printable on purpose: tmux 3.4-3.5a print control characters as octal text (`\037`),
 * and a client without a UTF-8 locale gets them as `_`, on any version.
 */
export const SEP = "|senu|"
const FIELDS = [
  "pane_id",
  "pane_pid",
  "pane_current_command",
  "pane_active",
  "pane_dead",
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
  // Keep the free-text title last so embedded separators cannot shift the fixed fields.
  "pane_title",
]
const FORMAT = FIELDS.map((f) => `#{${f}}`).join(SEP)

async function run(argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { ok: code === 0, out }
  } catch {
    return { ok: false, out: "" }
  }
}

let socketArgs: string[] = []

/** Pass tmux socket selectors (`-L name` or `-S path`); an empty list leaves socket selection to tmux. */
export function setTmuxSocket(args: string[]) {
  socketArgs = args
}

export const tmux = (...args: string[]) => run(["tmux", ...socketArgs, ...args])

export async function listPanes(): Promise<Pane[]> {
  const { out } = await tmux(...listArgs([]))
  return parsePanes(out)
}

const listArgs = (silent: string[][]) => [
  ...silent.flatMap((c) => [...c, ";"]),
  "list-panes",
  "-a",
  "-F",
  FORMAT,
]

/**
 * `listPanes`, with `ids` captured in the same tmux call (the panes a caller expects to
 * read, e.g. last poll's agents). A pane that has gone stops tmux's chain, so the
 * screens may miss some `ids`; the listing, which runs first, is always whole.
 */
export async function listPanesWithCaptures(
  silent: string[][],
  ids: string[],
): Promise<{ panes: Pane[]; screens: Map<string, string> }> {
  const args = listArgs(silent)
  if (ids.length) args.push(";", ...captureArgs(ids.slice(0, MAX_CHAINED)))
  const { out } = await tmux(...args)
  const at = out.search(CAPTURE_MARK)
  return {
    panes: parsePanes(at < 0 ? out : out.slice(0, at)),
    screens: at < 0 ? new Map() : parseCaptures(out.slice(at)),
  }
}

function parsePanes(out: string): Pane[] {
  const panes: Pane[] = []
  for (const line of out.split("\n")) {
    const f = line.split(SEP)
    if (f.length < FIELDS.length) continue
    const [
      id,
      pid,
      command,
      active,
      dead,
      session,
      attached,
      windowId,
      windowIndex,
      windowName,
      windowActive,
      activity,
      aiState,
      host,
      hostShort,
    ] = f
    const title = f.slice(FIELDS.length - 1).join(SEP)
    panes.push({
      id: id!,
      pid: Number(pid),
      command: command!,
      title,
      // tmux titles a pane with the host name until something sets one; herdr would see no title
      oscTitle: title === host || title === hostShort ? "" : title,
      active: active === "1",
      dead: dead === "1",
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
  EVAL_FLAGS.some(
    (f) =>
      arg === f ||
      (f.startsWith("--") ? arg.startsWith(`${f}=`) : !arg.startsWith("--") && arg.startsWith(f)),
  )
/** Runtime flags that take the next argument as their value. */
const VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--loader",
  "--import",
  "--experimental-loader",
  "--inspect-port",
  "-W",
  "-X",
  "-S",
  "-L",
  "-o",
])

/** A path's basename, lowercased, without a script or Windows suffix, as herdr normalises it. */
function baseName(token: string): string {
  const base =
    token
      .replace(/^["']+|["']+$/g, "")
      .split(/[/\\]/)
      .findLast(Boolean) ?? ""
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
  const name = baseName(argv0.replace(/^-/, ""))
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
  command: string
}

const CTL_KERN = 1
const KERN_PROCARGS2 = 49

const macSysctl =
  process.platform === "darwin"
    ? dlopen("/usr/lib/libSystem.B.dylib", {
        sysctl: {
          args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
          returns: FFIType.i32,
        },
      }).symbols.sysctl
    : null

/** Returns a process's argv, or an empty list when it cannot be read. */
export function processArgv(pid: number): string[] {
  try {
    if (process.platform === "linux") {
      const argv = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0")
      if (argv.at(-1) === "") argv.pop()
      return argv
    }
    if (!macSysctl) return []
    const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid])
    const size = new BigUint64Array(1)
    if (macSysctl(ptr(mib), 3, 0, ptr(size), 0, 0) !== 0 || size[0] === 0n) return []
    const data = new Uint8Array(Number(size[0]))
    if (macSysctl(ptr(mib), 3, ptr(data), ptr(size), 0, 0) !== 0) return []
    const bytes = Buffer.from(data.subarray(0, Number(size[0])))
    const argc = bytes.readInt32LE(0)
    if (argc <= 0) return []
    let at = bytes.indexOf(0, 4) + 1
    while (at < bytes.length && bytes[at] === 0) at++
    const argv: string[] = []
    for (let i = 0; i < argc && at < bytes.length; i++) {
      const end = bytes.indexOf(0, at)
      if (end < 0) return []
      argv.push(bytes.toString("utf8", at, end))
      at = end + 1
    }
    return argv
  } catch {
    return []
  }
}

async function processTable(panes: Pane[]): Promise<Proc[] | null> {
  const { ok, out } = await run(["ps", "-ax", "-o", "pid=,pgid=,tpgid=,comm="])
  if (!ok) return null
  const rows: Proc[] = []
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/.exec(line)
    if (m) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), tpgid: Number(m[3]), command: m[4]! })
  }
  const shellPids = new Set(panes.map((p) => p.pid))
  const foreground = new Set(
    rows.filter((p) => shellPids.has(p.pid) && p.tpgid > 0).map((p) => p.tpgid),
  )
  return rows.filter((p) => shellPids.has(p.pid) || foreground.has(p.pgid))
}

const needsArgv = (command: string) =>
  isRuntime(baseName(command)) || VERSION_COMMAND.test(baseName(command))
const claudeVersionPath = (path: string) =>
  /(?:^|[/\\])claude[/\\]versions[/\\]\d+\.\d+(?:\.\d+)?(?:$|[/\\])/.test(path)

export function agentFromProcess(command: string, argv: () => string[]): Agent | null {
  const direct = parseAgent(baseName(command))
  if (direct) return direct
  if (!needsArgv(command)) return null
  if (claudeVersionPath(command)) return "claude"
  const args = argv()
  return claudeVersionPath(args[0] ?? "") ? "claude" : agentFromArgv(args)
}

function agentInForeground(
  pane: Pane,
  procs: Proc[],
  argvFor: (pid: number) => string[],
): Agent | null | undefined {
  const shell = procs.find((p) => p.pid === pane.pid)
  if (!shell || shell.tpgid <= 0) return undefined
  const group = procs.filter((p) => p.pgid === shell.tpgid)
  if (!group.length) return undefined
  const leader = group.find((p) => p.pid === shell.tpgid)
  let unresolved = false
  for (const p of leader ? [leader, ...group.filter((g) => g !== leader)] : group) {
    const agent = agentFromProcess(p.command, () => {
      const argv = argvFor(p.pid)
      if (!argv.length) unresolved = true
      return argv
    })
    if (agent) return agent
  }
  return unresolved ? undefined : null
}

interface Identification {
  agents: AgentPane[]
  unresolved: Set<string>
}

async function identifyAgentsChecked(panes: Pane[]): Promise<Identification> {
  const direct = (p: Pane) => parseAgent(baseName(p.command))
  const procs = panes.some((p) => !p.dead && !direct(p) && needsArgv(p.command))
    ? await processTable(panes)
    : []
  const argvCache = new Map<number, string[]>()
  const argvFor = (pid: number) => {
    let argv = argvCache.get(pid)
    if (!argv) argvCache.set(pid, (argv = processArgv(pid)))
    return argv
  }

  const found: AgentPane[] = []
  const unresolved = new Set<string>()
  for (const p of panes) {
    // A dead pane keeps its pid and command, but no process runs there anymore.
    if (p.dead) continue
    let agent = direct(p)
    if (!agent && needsArgv(p.command)) {
      if (procs === null) {
        unresolved.add(p.id)
        continue
      }
      const detected = agentInForeground(p, procs, argvFor)
      if (detected === undefined) {
        unresolved.add(p.id)
        continue
      }
      agent = detected
    }
    if (agent) found.push({ ...p, agent })
  }
  return { agents: found, unresolved }
}

export async function identifyAgents(panes: Pane[]): Promise<AgentPane[]> {
  return (await identifyAgentsChecked(panes)).agents
}

const RUNTIME_RECHECK_MS = 5_000
const procKey = (pane: Pane) => `${pane.pid}\x1f${pane.command}\x1f${pane.dead}`

/** Avoid repeated process-table reads while bounding stale runtime identifications. */
export class AgentCache {
  private entries = new Map<string, { proc: string; agent: Agent | null; checkedAt: number }>()
  private readonly lookup: typeof identifyAgentsChecked

  constructor(lookup: typeof identifyAgentsChecked = identifyAgentsChecked) {
    this.lookup = lookup
  }

  async identify(panes: Pane[], now = performance.now()): Promise<AgentPane[]> {
    const fresh = panes.filter((pane) => {
      const entry = this.entries.get(pane.id)
      return (
        !entry ||
        entry.proc !== procKey(pane) ||
        (needsArgv(pane.command) && now - entry.checkedAt >= RUNTIME_RECHECK_MS)
      )
    })
    if (fresh.length) {
      const { agents, unresolved } = await this.lookup(fresh)
      const found = new Map(agents.map((pane) => [pane.id, pane.agent]))
      for (const pane of fresh) {
        if (unresolved.has(pane.id)) {
          if (this.entries.get(pane.id)?.proc !== procKey(pane)) this.entries.delete(pane.id)
          continue
        }
        this.entries.set(pane.id, {
          proc: procKey(pane),
          agent: found.get(pane.id) ?? null,
          checkedAt: now,
        })
      }
    }
    const live = new Set(panes.map((pane) => pane.id))
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id)
    return panes.flatMap((pane) => {
      const agent = this.entries.get(pane.id)?.agent
      return agent ? [{ ...pane, agent }] : []
    })
  }

  clear() {
    this.entries.clear()
  }
}

export async function listAgentPanes(): Promise<AgentPane[]> {
  return identifyAgents(await listPanes())
}

/**
 * The visible screen of each pane, which is what herdr's engine reads.
 * `history` adds that many scrollback lines above it (the picker's Codex label
 * wants more), but classifying should use 0: rules anchor on the screen's top.
 */
/** Random per process, so no screen can print a line that passes for a marker. */
const MARK = `senu-${crypto.randomUUID().slice(0, 8)}`
const CAPTURE_MARK = new RegExp(`^${MARK} \\d+$`, "m")
/** Captures per tmux call: ~60 bytes each keeps a call well under tmux's ~16 KB limit. */
const MAX_CHAINED = 100

const captureOne = (id: string, history = 0) => [
  "capture-pane",
  "-p",
  "-t",
  id,
  ...(history > 0 ? ["-S", `-${history}`] : []),
]

/** The marker leaves out the `%` of the pane id: display-message runs its text through strftime, which eats `%1`. */
export function captureArgs(ids: string[], history = 0): string[] {
  const args: string[] = []
  for (const id of ids)
    args.push(
      ...(args.length ? [";"] : []),
      "display-message",
      "-p",
      "-t",
      id,
      `${MARK} ${id.slice(1)}`,
      ";",
      ...captureOne(id, history),
    )
  return args
}

export function parseCaptures(out: string): Map<string, string> {
  const screens = new Map<string, string>()
  const parts = out.split(new RegExp(`^${MARK} (\\d+)\\n`, "m"))
  for (let i = 1; i + 1 < parts.length; i += 2) screens.set(`%${parts[i]}`, parts[i + 1]!)
  return screens
}

export async function capturePanes(ids: string[], history = 0): Promise<Map<string, string>> {
  const screens = new Map<string, string>()
  for (let i = 0; i < ids.length; i += MAX_CHAINED) {
    const chunk = ids.slice(i, i + MAX_CHAINED)
    for (const [id, screen] of parseCaptures((await tmux(...captureArgs(chunk, history))).out))
      screens.set(id, screen)
  }

  // tmux stops at the first failing command, so a pane that closed mid-poll hides the rest
  const missing = ids.filter((id) => !screens.has(id))
  if (missing.length) {
    const rest = await Promise.all(
      missing.map(async (id) => [id, await tmux(...captureOne(id, history))] as const),
    )
    for (const [id, r] of rest) if (r.ok) screens.set(id, r.out)
  }
  return screens
}

export async function capturePane(id: string, history = 0): Promise<string | null> {
  const { ok, out } = await tmux(
    "capture-pane",
    "-p",
    "-t",
    id,
    ...(history > 0 ? ["-S", `-${history}`] : []),
  )
  return ok ? out : null
}

/** Resolves a tmux pane, window, or session target; returns null when no pane matches. */
export async function findPane(target: string): Promise<Pane | null> {
  const { ok, out } = await tmux("display-message", "-p", "-t", target, "#{pane_id}")
  if (!ok) return null
  const id = out.trim()
  return (await listPanes()).find((p) => p.id === id) ?? null
}
