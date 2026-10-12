import { readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"

import type { Profile } from "~/config.ts"
import { profileKey } from "~/usage/cache.ts"

import type { Message, Only, Thread, ToolKind } from "./thread.ts"
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

const CLAUDE_TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "run",
  BashOutput: "run",
  Grep: "search",
  Glob: "search",
  WebFetch: "web",
  WebSearch: "web",
  Agent: "agent",
  Task: "agent",
  SendMessage: "agent",
  TaskStop: "agent",
  ListAgents: "agent",
}

export function claudeTools(r: Record<string, unknown>): ToolKind[] {
  if (r.type !== "assistant" || r.isSidechain) return []
  const content = (r.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((b) => b?.type === "tool_use")
    .map((b) => CLAUDE_TOOL_KINDS[String(b.name)] ?? "other")
}

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

export function claudeThreads(p: Profile, only?: Only): Thread[] {
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
      const sessionId = basename(name, ".jsonl")
      // Reading a transcript costs far more than its mtime, so skipped ones are never opened
      const updatedMs = statSync(path).mtimeMs
      if (only && !only.ids.has(sessionId) && updatedMs < (only.since ?? Infinity)) continue
      const summary = claudeSummary(headRecords(path, HEAD_BYTES), tailRecords(path, TAIL_BYTES))
      if (!summary) continue
      threads.push({
        sessionId,
        agent: "claude",
        profile: profileKey(p),
        home: p.home,
        ...summary,
        updatedMs,
        transcript: path,
      })
    }
  }
  return threads
}
