import { readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"

import type { UsageProfile } from "~/config.ts"
import { profileKey } from "~/usage/cache.ts"

import type { Message, Thread } from "./thread.ts"
import { firstLine, headRecords, tailRecords } from "./transcript.ts"

/**
 * Claude keeps one transcript per session at `projects/<dir>/<id>.jsonl`;
 * subagents live a level deeper, under `<id>/subagents/`, so listing only the
 * top level leaves them out. Claude re-appends an `ai-title` record as it
 * renames the session, so the tail carries the current title, and the head
 * carries the first prompt for sessions that never got one.
 */

const HEAD_BYTES = 64 << 10
const TAIL_BYTES = 256 << 10

export function claudeMessage(r: Record<string, unknown>): Message | null {
  if ((r.type !== "user" && r.type !== "assistant") || r.isMeta || r.isSidechain) return null
  // Claude writes its own "API Error: …" lines as assistant turns, and /compact's summary as a user one
  if (r.isApiErrorMessage || r.isCompactSummary) return null
  const content = (r.message as { content?: unknown } | undefined)?.content
  const text = (
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string)
            .join("\n")
        : ""
  ).trim()
  // `<command-name>`, `<local-command-stdout>` and the like are Claude's own wrappers
  return text && !text.startsWith("<") ? { fromUser: r.type === "user", text } : null
}

const firstCwd = (rs: Record<string, unknown>[]) =>
  rs.find((r) => typeof r.cwd === "string")?.cwd as string | undefined

export function claudeSummary(
  head: Record<string, unknown>[],
  tail: Record<string, unknown>[],
): { title: string; cwd: string } | null {
  const aiTitle = tail.findLast((r) => r.type === "ai-title" && typeof r.aiTitle === "string")
  const firstPrompt = head.map(claudeMessage).find((m) => m?.fromUser)
  const title =
    (aiTitle?.aiTitle as string | undefined) ?? (firstPrompt && firstLine(firstPrompt.text))
  if (!title) return null
  // Records follow a mid-session cd, but Claude files the session under the cwd it started in
  return { title, cwd: firstCwd(head) ?? firstCwd(tail) ?? "" }
}

export function claudeThreads(p: UsageProfile): Thread[] {
  const root = join(p.home, "projects")
  let dirs
  try {
    dirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const threads: Thread[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    for (const name of readdirSync(join(root, dir.name))) {
      if (!name.endsWith(".jsonl")) continue
      const path = join(root, dir.name, name)
      const summary = claudeSummary(headRecords(path, HEAD_BYTES), tailRecords(path, TAIL_BYTES))
      if (!summary) continue
      threads.push({
        sessionId: basename(name, ".jsonl"),
        agent: "claude",
        profile: profileKey(p),
        home: p.home,
        ...summary,
        updatedMs: statSync(path).mtimeMs,
        transcript: path,
      })
    }
  }
  return threads
}
