import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { basename, join, relative, sep } from "node:path"

import type { Config, Profile } from "~/config.ts"
import { allowedProfiles } from "~/privacy.ts"
import { claudeMessage } from "~/threads/claude.ts"
import { codexMessage } from "~/threads/codex.ts"
import { profileKey } from "~/usage/cache.ts"

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
    const rel = relative(root, realpathSync(path))
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

// Characters every transcript writer stores unescaped, so a raw-line match is exact.
const PLAIN = /^[\w .,:;@#=+()[\]-]+$/

export function searchThreads(
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
  const needle = options.query.toLowerCase()
  const raw = PLAIN.test(needle) ? new RegExp(needle.replace(/[.+()[\]]/g, "\\$&"), "i") : undefined
  const excluded = new Set(
    [
      ...(options.excludeSession ?? []),
      env.CODEX_THREAD_ID,
      env.CLAUDE_CODE_SESSION_ID,
      env.CLAUDE_SESSION_ID,
    ].filter(Boolean),
  )
  const hits: SearchHit[] = []
  const failed: { path: string; error: string }[] = []
  const seen = new Set<string>()
  const paths: { p: Profile; path: string }[] = []
  for (const p of profiles) {
    try {
      paths.push(...transcriptFiles(p).map((path) => ({ p, path })))
    } catch (e) {
      if (existsSync(p.home)) failed.push({ path: p.home, error: String(e) })
    }
  }
  paths.sort(
    (a, b) =>
      Number(a.path.endsWith(".zst")) - Number(b.path.endsWith(".zst")) ||
      a.path.localeCompare(b.path),
  )
  for (const { p, path } of paths) {
    try {
      const bytes = readFileSync(path)
      const content = path.endsWith(".zst") ? Bun.zstdDecompressSync(bytes) : bytes
      // Decoding and parsing dominate the cost, so skip files and lines that cannot hold the
      // phrase. latin1 skips UTF-8 decoding and cannot change an ASCII match.
      if (raw && !raw.test(content.toString("latin1"))) continue
      const lines = content.toString("utf8").split("\n")
      let session = basename(path).replace(/\.jsonl(?:\.zst)?$/, "")
      let skip = false
      for (const [index, line] of lines.entries()) {
        if (raw && !line.includes('"session_meta"') && !raw.test(line)) continue
        let r
        try {
          r = JSON.parse(line)
        } catch {
          continue
        }
        if (!r || typeof r !== "object") continue
        if (r.type === "session_meta") {
          session = r.payload?.id ?? r.payload?.session_id ?? session
          skip =
            !!r.payload?.agent_role ||
            ![undefined, "cli", "vscode", "exec", "app", "desktop"].includes(r.payload?.source)
        }
        session = r.sessionId ?? session
        if (
          skip ||
          r.isSidechain ||
          excluded.has(session) ||
          (options.session && options.session !== session)
        )
          continue
        const m = p.kind === "claude" ? claudeMessage(r) : codexMessage(r)
        const payload = r.payload
        const role = m ? (m.fromUser ? "user" : "assistant") : "tool"
        let text = m?.text ?? ""
        if (
          !m &&
          p.kind === "codex" &&
          r.type === "response_item" &&
          ["function_call_output", "custom_tool_call_output"].includes(payload?.type)
        )
          text = typeof payload.output === "string" ? payload.output : ""
        if (!m && p.kind === "claude" && r.type === "user" && Array.isArray(r.message?.content))
          text = r.message.content
            .filter((b: { type: string }) => b.type === "tool_result")
            .map((b: { content: unknown }) =>
              typeof b.content === "string"
                ? b.content
                : Array.isArray(b.content)
                  ? b.content
                      .filter((x) => x?.type === "text")
                      .map((x) => x.text)
                      .join("\n")
                  : "",
            )
            .join("\n")
        if ((options.role ?? "user") !== "all" && (options.role ?? "user") !== role) continue
        const at = text.toLowerCase().indexOf(needle)
        if (at < 0) continue
        const excerpt = text.slice(
          Math.max(0, at - 100),
          Math.min(at + options.query.length + 220, at + 500),
        )
        const key = JSON.stringify([profileKey(p), session, role, text])
        if (seen.has(key)) continue
        seen.add(key)
        if (hits.length === limit)
          return { profiles: profiles.map(profileKey), hits, limit_reached: true, failed }
        hits.push({ session, profile: profileKey(p), path, line: index + 1, role, excerpt })
      }
    } catch (e) {
      failed.push({ path, error: String(e) })
    }
  }
  return { profiles: profiles.map(profileKey), hits, limit_reached: false, failed }
}
