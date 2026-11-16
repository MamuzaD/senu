import { readdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"

import type { Profile } from "~/config.ts"
import { agentFromProcess, processArgv, run, type Pane } from "~/detect/panes.ts"
import { profileKey } from "~/usage/cache.ts"

import { codexThreadIdentities, type CodexThreadIdentity } from "./codex.ts"
import { threadKey } from "./thread.ts"

// Claude writes sessions/<pid>.json naming its session and leaves it behind if it crashes, so a
// reused pid can claim it. Codex holds thread-writer-locks/<id>.lock open while a thread runs; a
// crash can leave the file behind, never the open descriptor.

/** The threads each process holds, by `threadKey` */
type SessionsByPid = Map<number, string[]>

function hold(holders: SessionsByPid, pid: number, key: string) {
  holders.set(pid, [...(holders.get(pid) ?? []), key])
}

function claudeSessionsByPid(p: Profile, holders: SessionsByPid) {
  const dir = join(p.home, "sessions")
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const { pid, sessionId } = JSON.parse(readFileSync(join(dir, name), "utf8"))
      if (Number.isInteger(pid) && typeof sessionId === "string")
        hold(holders, pid, threadKey(profileKey(p), sessionId))
    } catch {}
  }
}

// lsof -F prints a `p<pid>` line, then an `n<path>` line per open file. `profileOf` names the
// profile whose lock directory a lock is in.
export function parseLsof(
  out: string,
  profileOf: (lockDir: string) => string | undefined,
  holders: SessionsByPid = new Map(),
): SessionsByPid {
  let pid = 0
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && line.endsWith(".lock") && pid) {
      const lock = line.slice(1)
      const profile = profileOf(dirname(lock))
      if (profile) hold(holders, pid, threadKey(profile, basename(lock, ".lock")))
    }
  }
  return holders
}

const lockDir = (home: string) => join(home, "thread-writer-locks")

function codexLocks(home: string): string[] {
  const dir = lockDir(home)
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".lock") && !n.startsWith("."))
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

export interface Proc {
  ppid: number
  command: string
}

export function parseProcs(out: string): Map<number, Proc> {
  const procs = new Map<number, Proc>()
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line)
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), command: m[3]! })
  }
  return procs
}

export function stillClaude(
  claude: SessionsByPid,
  procs: Map<number, Proc>,
  argv: (pid: number) => string[] = processArgv,
): SessionsByPid {
  return new Map(
    [...claude].filter(([pid]) => {
      const proc = procs.get(pid)
      return proc && agentFromProcess(proc.command, () => argv(pid)) === "claude"
    }),
  )
}

export function panesFor(
  holders: SessionsByPid,
  procs: Map<number, Proc>,
  panes: Pick<Pane, "id" | "pid">[],
): Map<string, string> {
  const byShell = new Map(panes.map((p) => [p.pid, p.id]))
  const live = new Map<string, string>()
  for (const [pid, sessions] of holders) {
    let at: number | undefined = pid
    while (at !== undefined && at > 1 && !byShell.has(at)) at = procs.get(at)?.ppid
    const pane = at === undefined ? undefined : byShell.get(at)
    if (pane) for (const s of sessions) live.set(s, pane)
  }
  return live
}

export interface Holder {
  pid: number
  command: string
}

export interface Running {
  /** Running threads' panes, by `threadKey` */
  paneByThread: Map<string, string>
  /** The processes holding threads outside every pane, by `threadKey` */
  offPane: Map<string, Holder>
}

/** The holders `panesFor` could not place, leaving out processes that exited. */
export function offPanes(
  holders: SessionsByPid,
  procs: Map<number, Proc>,
  paneByThread: Map<string, string>,
): Map<string, Holder> {
  const off = new Map<string, Holder>()
  for (const [pid, keys] of holders) {
    const proc = procs.get(pid)
    if (!proc) continue
    for (const key of keys)
      if (!paneByThread.has(key)) off.set(key, { pid, command: basename(proc.command) })
  }
  return off
}

/** App servers can own many threads, even while still parented by the first TUI. */
export function codexServers(
  pids: number[],
  argv: (pid: number) => string[] = processArgv,
): Set<number> {
  return new Set(pids.filter((pid) => argv(pid).includes("app-server")))
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// Mirror Codex's status_surfaces.rs + terminal_title.rs: trim, truncate by
// grapheme, then sanitize the assembled title. Order matters at the boundary.
const titleWhitespace = /\p{White_Space}/u
const disallowedTitleChar =
  // oxlint-disable-next-line eslint/no-misleading-character-class -- intentionally strip Codex's exact combining/invisible codepoint ranges
  /[\p{Cc}\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff\ufff9-\ufffb\u{1bca0}-\u{1bca3}\u{e0100}-\u{e01ef}]/u
const activityPrefixes = [
  "",
  "● ",
  ...["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"].flatMap((s) => [`${s} `, `● ${s} `]),
]

function sanitizeTitle(title: string): string {
  let out = ""
  let count = 0
  let space = false
  for (const ch of title) {
    if (titleWhitespace.test(ch)) {
      space = out.length > 0
      continue
    }
    if (disallowedTitleChar.test(ch)) continue
    if (space && 240 - count > 1) {
      out += " "
      count++
      space = false
    }
    if (count >= 240) break
    out += ch
    count++
  }
  return out
}

function terminalThreadTitles(title: string): string[] {
  const trimmed = title.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "")
  if (!trimmed) return []
  const chars = [...graphemes.segment(trimmed)].map((g) => g.segment)
  const name = chars.length > 48 ? chars.slice(0, 45).join("") + "..." : trimmed
  // Keep the separator during sanitization so trailing whitespace/invisibles
  // behave as they do in the complete `<activity><name> | <project>` title.
  return activityPrefixes.map((prefix) => sanitizeTitle(`${prefix}${name} |`))
}

type TitledPane = Pick<Pane, "id" | "oscTitle" | "cwd" | "session">

/** Only accept a title/cwd match unique across both open threads and client panes. */
export function addCodexTitles(
  live: Map<string, string>,
  threads: CodexThreadIdentity[],
  panes: TitledPane[],
): Map<string, string> {
  const identities = threads.map((t) => ({
    key: t.key,
    cwd: t.cwd,
    titles: new Set(t.titles.flatMap(terminalThreadTitles)),
  }))
  const candidates = panes.map((pane) => {
    const blocked = /^(?:● )?(?:\[ [!.] \] )?Action Required(?: \||$)/i.test(pane.oscTitle)
    return {
      pane: pane.id,
      threads: blocked
        ? []
        : identities.filter(
            (t) =>
              t.cwd === pane.cwd &&
              [...t.titles].some((title) => pane.oscTitle.startsWith(title + " ")),
          ),
    }
  })
  const matched = new Map(live)
  const occupied = new Set(live.values())
  for (const { pane, threads: matches } of candidates) {
    const thread = matches.length === 1 ? matches[0] : undefined
    if (!thread || matched.has(thread.key) || occupied.has(pane)) continue
    if (candidates.filter((c) => c.threads.some((t) => t.key === thread.key)).length === 1) {
      matched.set(thread.key, pane)
      occupied.add(pane)
    }
  }
  return matched
}

export async function runningThreads(
  profiles: Profile[],
  panes: (Pick<Pane, "id" | "pid"> &
    Partial<Pick<Pane, "oscTitle" | "cwd" | "session" | "dead">>)[],
): Promise<Running> {
  const claude: SessionsByPid = new Map()
  for (const p of profiles) if (p.kind === "claude") claudeSessionsByPid(p, claude)
  const codex = profiles.filter((p) => p.kind === "codex")
  const locks = codex.flatMap((p) => codexLocks(p.home))
  // lsof names files by their real path
  const real = (dir: string) => {
    try {
      return realpathSync(dir)
    } catch {
      return dir
    }
  }
  const profileByDir = new Map(codex.map((p) => [real(lockDir(p.home)), profileKey(p)]))
  const procs = parseProcs((await run(["ps", "-axo", "pid=,ppid=,comm="])).out)
  // lsof checks every process's files unless given pids, which takes it ~400 ms
  const pids = locks.length ? codexPids(procs) : []
  const lsof = pids.length
    ? await run(["lsof", "-nP", "-a", "-p", pids.join(","), "-Fpn", "--", ...locks])
    : { out: "" }
  const holders = parseLsof(lsof.out, (dir) => profileByDir.get(dir), stillClaude(claude, procs))
  const servers = codexServers(pids)
  const direct = new Map([...holders].filter(([pid]) => !servers.has(pid)))
  const live = panesFor(direct, procs, panes)
  const clients = panesFor(
    new Map(pids.filter((pid) => !servers.has(pid)).map((pid) => [pid, [String(pid)]])),
    procs,
    panes,
  )
  const clientPanes = new Set(clients.values())
  const titled = panes.flatMap((p) =>
    clientPanes.has(p.id) &&
    !p.dead &&
    p.oscTitle !== undefined &&
    p.cwd !== undefined &&
    p.session !== undefined
      ? [{ id: p.id, oscTitle: p.oscTitle, cwd: p.cwd, session: p.session }]
      : [],
  )
  const open = new Set([...holders.values()].flat())
  const identities =
    servers.size && titled.length
      ? codex.flatMap((p) => {
          try {
            return codexThreadIdentities(p, open)
          } catch {
            // listThreads reports unreadable profiles; retain the other process matches.
            return []
          }
        })
      : []
  const paneByThread = addCodexTitles(live, identities, titled)
  return { paneByThread, offPane: offPanes(holders, procs, paneByThread) }
}

export function codexPids(
  procs: Map<number, Proc>,
  argv: (pid: number) => string[] = processArgv,
): number[] {
  return [...procs]
    .filter(([pid, p]) => agentFromProcess(p.command, () => argv(pid)) === "codex")
    .map(([pid]) => pid)
}

/** MCP children do not receive CODEX_THREAD_ID. Only use locks owned by their direct
 * parent, and let the caller reject ambiguous parents such as a shared daemon. */
export async function parentCodexThreads(
  profiles: Profile[],
  pid = process.ppid,
): Promise<Set<string>> {
  const codex = profiles.filter((p) => p.kind === "codex")
  const locks = codex.flatMap((p) => codexLocks(p.home))
  if (!locks.length) return new Set()
  const profileByDir = new Map(
    codex
      .filter((p) => codexLocks(p.home).length)
      .map((p) => [realpathSync(lockDir(p.home)), profileKey(p)]),
  )
  const result = await run(["lsof", "-nP", "-a", "-p", String(pid), "-Fpn", "--", ...locks])
  const holders = parseLsof(result.out, (dir) => profileByDir.get(dir))
  return new Set(holders.get(pid) ?? [])
}
