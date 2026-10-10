import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { UsageProfile } from "~/config.ts"
import { agentFromProcess, processArgv, run, type Pane } from "~/detect/panes.ts"

// Claude writes sessions/<pid>.json naming its session and leaves it behind if it crashes, so a
// reused pid can claim it. Codex holds thread-writer-locks/<id>.lock open while a thread runs; a
// crash can leave the file behind, never the open descriptor.

type SessionsByPid = Map<number, string[]>

function hold(holders: SessionsByPid, pid: number, sessionId: string) {
  holders.set(pid, [...(holders.get(pid) ?? []), sessionId])
}

function claudeSessionsByPid(home: string, holders: SessionsByPid) {
  const dir = join(home, "sessions")
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
      if (Number.isInteger(pid) && typeof sessionId === "string") hold(holders, pid, sessionId)
    } catch {}
  }
}

// lsof -F prints a `p<pid>` line, then an `n<path>` line per open file
export function parseLsof(out: string, holders: SessionsByPid = new Map()): SessionsByPid {
  let pid = 0
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && line.endsWith(".lock") && pid) {
      hold(holders, pid, line.slice(line.lastIndexOf("/") + 1, -".lock".length))
    }
  }
  return holders
}

function codexLocks(home: string): string[] {
  const dir = join(home, "thread-writer-locks")
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

export async function liveSessions(
  profiles: UsageProfile[],
  panes: Pane[],
): Promise<Map<string, string>> {
  const claude: SessionsByPid = new Map()
  for (const p of profiles) if (p.kind === "claude") claudeSessionsByPid(p.home, claude)
  const locks = profiles.filter((p) => p.kind === "codex").flatMap((p) => codexLocks(p.home))
  const [lsof, ps] = await Promise.all([
    locks.length ? run(["lsof", "-Fpn", "--", ...locks]) : { out: "" },
    run(["ps", "-axo", "pid=,ppid=,comm="]),
  ])
  const procs = parseProcs(ps.out)
  return panesFor(parseLsof(lsof.out, stillClaude(claude, procs)), procs, panes)
}
