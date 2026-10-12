import { readdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"

import type { Profile } from "~/config.ts"
import { agentFromProcess, processArgv, run, type Pane } from "~/detect/panes.ts"
import { profileKey } from "~/usage/cache.ts"

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

export async function runningThreads(
  profiles: Profile[],
  panes: Pane[],
): Promise<Map<string, string>> {
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
  return panesFor(holders, procs, panes)
}

export function codexPids(
  procs: Map<number, Proc>,
  argv: (pid: number) => string[] = processArgv,
): number[] {
  return [...procs]
    .filter(([pid, p]) => agentFromProcess(p.command, () => argv(pid)) === "codex")
    .map(([pid]) => pid)
}
