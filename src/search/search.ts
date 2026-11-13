import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join, relative, sep } from "node:path"

import type { Config, Profile } from "~/config.ts"
import { compiled } from "~/paths.ts"
import { allowedProfiles } from "~/privacy.ts"
import { profileKey } from "~/usage/cache.ts"

import type { Spec } from "./scan.ts"
import type { Scanned, Task } from "./worker.ts"

export interface SearchOptions {
  query: string
  session?: string | undefined
  role?: "user" | "assistant" | "tool" | "all" | undefined
  limit?: number | undefined
  scope?: string | undefined
  excludeSession?: string[]
}
export interface SearchHit {
  session: string
  profile: string
  cwd: string
  time: string
  path: string
  line: number
  role: string
  excerpt: string
}

function files(root: string, base: string): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    return out
  }
  for (const e of entries) {
    if (e.name === "subagents" || e.isSymbolicLink()) continue
    const path = join(base, e.name)
    // Codex deletes a rollout once it has compressed it
    let real
    try {
      real = realpathSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      continue
    }
    const rel = relative(root, real)
    if (rel === ".." || rel.startsWith(`..${sep}`)) continue
    if (e.isDirectory()) out.push(...files(root, path))
    else if (
      e.name.endsWith(".jsonl") ||
      (e.name.endsWith(".jsonl.zst") && !existsSync(path.slice(0, -4)))
    )
      out.push(path)
  }
  return out
}

export function transcriptFiles(p: Profile): string[] {
  return (
    p.kind === "claude" ? ["projects"] : p.kind === "codex" ? ["sessions", "archived_sessions"] : []
  ).flatMap((dir) => files(realpathSync(p.home), join(p.home, dir)))
}

/** Scans on every core but one: reading and decoding a few GB of transcripts is the whole cost. */
async function scan(spec: Spec, jobs: Task["jobs"]): Promise<Scanned[]> {
  const shares: Task["jobs"][] = Array.from(
    { length: Math.min(jobs.length, Math.max(1, availableParallelism() - 1)) },
    () => [],
  )
  // Dealing the largest files out first keeps the shares even
  for (const [n, job] of jobs.toSorted((a, b) => b.size - a.size).entries())
    shares[n % shares.length]!.push(job)
  const workers: Worker[] = []
  try {
    const done = await Promise.all(
      shares.map(
        (share) =>
          new Promise<Scanned[]>((resolve, reject) => {
            // A compiled binary holds the worker as a second entrypoint, under its bundle root
            const worker = new Worker(
              compiled ? "./search/worker.ts" : new URL("./worker.ts", import.meta.url).href,
            )
            workers.push(worker)
            worker.addEventListener("message", (e: MessageEvent<Scanned[]>) => resolve(e.data))
            worker.addEventListener("error", (e) => reject(new Error(e.message)))
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker, not a window
            worker.postMessage({ spec, jobs: share } satisfies Task)
          }),
      ),
    )
    return done.flat().toSorted((a, b) => a.i - b.i)
  } finally {
    for (const worker of workers) worker.terminate()
  }
}

/** Hits come newest first. When no message holds the whole phrase, messages holding
 * every word of it match instead, and `match` says so. */
export async function searchThreads(
  config: Config,
  options: SearchOptions,
  env = process.env,
  terminal = false,
) {
  const limit = options.limit ?? 20
  if (!options.query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Provide a query and a limit between 1 and 100")
  if (options.role && !["user", "assistant", "tool", "all"].includes(options.role))
    throw new Error("Invalid role")
  const profiles = allowedProfiles(config, env, options.scope, terminal).filter(
    (p) => p.kind !== "opencode",
  )
  const failed: { path: string; error: string }[] = []
  const transcripts: { p: Profile; path: string; size: number }[] = []
  for (const p of profiles) {
    let paths
    try {
      paths = transcriptFiles(p)
    } catch (e) {
      if (existsSync(p.home)) failed.push({ path: p.home, error: String(e) })
      continue
    }
    for (const path of paths) {
      const size = statSync(path, { throwIfNoEntry: false })?.size
      if (size !== undefined) transcripts.push({ p, path, size })
    }
  }
  const spec: Spec = {
    query: options.query,
    role: options.role ?? "user",
    session: options.session,
    excluded: [
      ...(options.excludeSession ?? []),
      env.CODEX_THREAD_ID,
      env.CLAUDE_CODE_SESSION_ID,
      env.CLAUDE_SESSION_ID,
    ].filter((id): id is string => !!id),
  }
  const cap = options.session ? limit + 1 : 3
  const scanned = await scan(
    spec,
    transcripts.map(({ p, path, size }, i) => ({
      i,
      kind: p.kind as "claude" | "codex",
      path,
      size,
    })),
  )
  for (const s of scanned)
    if ("error" in s) failed.push({ path: transcripts[s.i]!.path, error: s.error })
  // A transcript's mtime moves when Codex compresses it, so the messages' own times set the order
  const found = scanned
    .flatMap((s) => ("found" in s ? s.found.map((f) => ({ f, ...transcripts[s.i]! })) : []))
    .toSorted((a, b) => (a.f.time < b.f.time ? 1 : a.f.time > b.f.time ? -1 : 0))
  const exact = found.some(({ f }) => f.exact)
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  const perSession = new Map<string, number>()
  let limit_reached = false
  for (const { f, p, path } of found) {
    const { exact: whole, key, ...hit } = f
    const profile = profileKey(p)
    const session = `${profile}\0${hit.session}`
    const count = perSession.get(session) ?? 0
    if (whole !== exact || seen.has(`${profile}\0${key}`) || count === cap) continue
    seen.add(`${profile}\0${key}`)
    perSession.set(session, count + 1)
    if (hits.length === limit) limit_reached = true
    else hits.push({ ...hit, profile, path })
  }
  return {
    profiles: profiles.map(profileKey),
    match: exact || !hits.length ? "phrase" : "words",
    hits,
    limit_reached,
    failed,
  }
}
