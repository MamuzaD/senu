import type { UsageProfile } from "~/config.ts"
import type { Agent } from "~/detect/manifest.ts"
import { profileKey } from "~/usage/cache.ts"

import { claudeMessage, claudeThreads, claudeTools } from "./claude.ts"
import { codexMessage, codexThreads, codexTools } from "./codex.ts"
import { tailRecords } from "./transcript.ts"

export interface Thread {
  sessionId: string
  agent: Agent
  profile: string
  home: string
  title: string
  cwd: string
  updatedMs: number
  transcript: string
}

export interface Message {
  fromUser: boolean
  text: string
}

export type ToolKind = "read" | "edit" | "run" | "search" | "web" | "agent" | "other"

export type Turn = Message | { tools: Partial<Record<ToolKind, number>> }

/** Narrows a listing to these sessions and any thread updated since `since`. */
export interface Only {
  ids: Set<string>
  since?: number
}

export interface Listed {
  threads: Thread[]
  failed: { profile: string; error: string }[]
}

export function listThreads(profiles: UsageProfile[], only?: Only): Listed {
  const threads: Thread[] = []
  const failed: Listed["failed"] = []
  for (const p of profiles) {
    try {
      threads.push(...(p.kind === "codex" ? codexThreads(p, only) : claudeThreads(p, only)))
    } catch (e) {
      failed.push({ profile: profileKey(p), error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { threads: threads.toSorted((a, b) => b.updatedMs - a.updatedMs), failed }
}

const PREVIEW_BYTES = 1 << 20

export function preview(thread: Thread, count: number): Turn[] {
  const [read, tools] =
    thread.agent === "codex" ? [codexMessage, codexTools] : [claudeMessage, claudeTools]
  const turns: Turn[] = []
  for (const r of tailRecords(thread.transcript, PREVIEW_BYTES)) {
    const m = read(r)
    if (m) turns.push(m)
    const kinds = tools(r)
    if (!kinds.length) continue
    let last = turns.at(-1)
    if (!last || !("tools" in last)) turns.push((last = { tools: {} }))
    for (const k of kinds) last.tools[k] = (last.tools[k] ?? 0) + 1
  }
  return turns.slice(-count)
}
