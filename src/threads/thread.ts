import { statSync } from "node:fs"

import type { Profile } from "~/config.ts"
import type { Agent } from "~/detect/manifest.ts"
import { profileKey } from "~/usage/cache.ts"

import { claudeMessage, claudeThreads, claudeTools } from "./claude.ts"
import { codexMessage, codexThreads, codexTools } from "./codex.ts"
import { opencodeMessage, opencodeRecords, opencodeThreads, opencodeTools } from "./opencode.ts"
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

/** A session id can show up in two profiles, e.g. a copied ~/.claude, so a thread is both. */
export function threadKey(profile: string, sessionId: string): string {
  return `${profile}:${sessionId}`
}

export interface Message {
  fromUser: boolean
  text: string
}

export type ToolKind = "read" | "edit" | "run" | "search" | "web" | "agent" | "other"

export type Turn = Message | { tools: Partial<Record<ToolKind, number>> }

/** Narrows a listing to these threads (by `threadKey`) and any updated since `since`. */
export interface Only {
  ids: Set<string>
  since?: number
}

export interface Listed {
  threads: Thread[]
  failed: { profile: string; error: string }[]
}

export function listThreads(profiles: Profile[], only?: Only): Listed {
  const threads: Thread[] = []
  const failed: Listed["failed"] = []
  for (const p of profiles) {
    try {
      const list = { codex: codexThreads, claude: claudeThreads, opencode: opencodeThreads }[p.kind]
      threads.push(...list(p, only))
    } catch (e) {
      failed.push({ profile: profileKey(p), error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { threads: threads.toSorted((a, b) => b.updatedMs - a.updatedMs), failed }
}

const PREVIEW_BYTES = 1 << 20
const PREVIEW_TURNS = 40

function turnsOf<R>(
  records: R[],
  read: (r: R) => Message | null,
  tools: (r: R) => ToolKind[],
): Turn[] {
  const turns: Turn[] = []
  for (const r of records) {
    const m = read(r)
    if (m) turns.push(m)
    const kinds = tools(r)
    if (!kinds.length) continue
    let last = turns.at(-1)
    if (!last || !("tools" in last)) turns.push((last = { tools: {} }))
    for (const k of kinds) last.tools[k] = (last.tools[k] ?? 0) + 1
  }
  return turns
}

/** A thread's turns from its last `bytes`, and whether it holds older ones. */
function readTurns(thread: Thread, bytes: number): { turns: Turn[]; more: boolean } {
  if (thread.agent === "opencode") {
    const { records, more } = opencodeRecords(thread, bytes)
    return { turns: turnsOf(records, opencodeMessage, opencodeTools), more }
  }
  const [read, tools] =
    thread.agent === "codex" ? [codexMessage, codexTools] : [claudeMessage, claudeTools]
  return {
    turns: turnsOf(tailRecords(thread.transcript, bytes), read, tools),
    more: statSync(thread.transcript).size > bytes,
  }
}

export function preview(thread: Thread, count: number, bytes = PREVIEW_BYTES): Turn[] {
  return readTurns(thread, bytes).turns.slice(-count)
}

/**
 * The last turns of a thread, twice as many and from twice as far back at each `depth`, and
 * whether the transcript holds any older ones.
 */
export function previewAt(thread: Thread, depth: number): { turns: Turn[]; more: boolean } {
  const count = PREVIEW_TURNS << depth
  const { turns, more } = readTurns(thread, PREVIEW_BYTES * 2 ** depth)
  return { turns: turns.slice(-count), more: more || turns.length > count }
}
