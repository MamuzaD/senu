import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join, relative, sep } from "node:path"

import type { Config, Profile } from "~/config.ts"
import { compiled } from "~/paths.ts"
import { allowedProfiles } from "~/privacy.ts"
import { claudeThreads } from "~/threads/claude.ts"
import { codexThreads } from "~/threads/codex.ts"
import { profileKey } from "~/usage/cache.ts"

import { excerpt, titleMatch, type Found, type Spec } from "./scan.ts"
import type { Scanned, Task } from "./worker.ts"

export interface SearchOptions {
  query: string
  session?: string | undefined
  role?: "user" | "assistant" | "tool" | "all" | undefined
  limit?: number | undefined
  scope?: string | undefined
  excludeSession?: string[]
  /** The most hits one session may return; 3, or one more than the limit with `session` */
  perSession?: number | undefined
  /** Search only thread titles or only messages; both when unset */
  only?: "threads" | "messages" | undefined
}
export interface SearchHit {
  session: string
  profile: string
  cwd: string
  time: string
  path: string
  /** Unset for a title */
  line?: number
  /** `title` for a thread title, else who wrote the message */
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

/** A mistake in how search was called, as opposed to a failure while searching */
export class UsageError extends Error {}

/** Threads whose titles match, as hits dated by the thread's last update */
function titleHits(profiles: Profile[], spec: Spec, failed: { path: string; error: string }[]) {
  const excluded = new Set(spec.excluded)
  return profiles.flatMap((p) => {
    let threads
    try {
      threads = p.kind === "claude" ? claudeThreads(p) : codexThreads(p)
    } catch (e) {
      if (existsSync(p.home)) failed.push({ path: p.home, error: String(e) })
      return []
    }
    return threads.flatMap((t) => {
      const match = titleMatch(t.title, spec.query)
      if (!match || excluded.has(t.sessionId) || (spec.session && spec.session !== t.sessionId))
        return []
      const f: Found = {
        session: t.sessionId,
        cwd: t.cwd,
        time: new Date(t.updatedMs).toISOString(),
        role: "title",
        excerpt: excerpt(t.title.replace(/\s+/g, " "), match.at),
        exact: match.exact,
        key: `${t.sessionId}\0title`,
      }
      return [{ f, p, path: t.transcript }]
    })
  })
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
  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= 100
  if (!options.query.trim() || !inRange(limit) || !inRange(options.perSession ?? 1))
    throw new UsageError("Provide a query, and a limit and per-session count between 1 and 100")
  if (options.role && !["user", "assistant", "tool", "all"].includes(options.role))
    throw new UsageError("Invalid role")
  const profiles = allowedProfiles(config, env, options.scope, terminal).filter(
    (p) => p.kind !== "opencode",
  )
  const failed: { path: string; error: string }[] = []
  const transcripts: { p: Profile; path: string; size: number }[] = []
  for (const p of options.only === "threads" ? [] : profiles) {
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
  const cap = options.perSession ?? (options.session ? limit + 1 : 3)
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
    .flatMap((s) => {
      const { p, path } = transcripts[s.i]!
      return "found" in s ? s.found.map((f) => ({ f, p, path })) : []
    })
    .concat(options.only === "messages" ? [] : titleHits(profiles, spec, failed))
    .toSorted((a, b) => (a.f.time < b.f.time ? 1 : a.f.time > b.f.time ? -1 : 0))
  const exact = found.some(({ f }) => f.exact)
  // A thread untitled by its agent goes by its first prompt, so its title would repeat a message
  // hit; a title only adds threads no message matched
  const inMessages = new Set(
    found.flatMap(({ f, p }) =>
      f.role !== "title" && f.exact === exact ? [`${profileKey(p)}\0${f.session}`] : [],
    ),
  )
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  const perSession = new Map<string, number>()
  let limit_reached = false
  for (const { f, p, path } of found) {
    const { exact: whole, key, ...hit } = f
    const profile = profileKey(p)
    const session = `${profile}\0${hit.session}`
    const count = perSession.get(session) ?? 0
    if (
      whole !== exact ||
      seen.has(`${profile}\0${key}`) ||
      count === cap ||
      (hit.role === "title" && inMessages.has(session))
    )
      continue
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
