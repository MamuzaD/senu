import type { UsageProfile } from "~/config.ts"
import type { Agent } from "~/detect/manifest.ts"
import { profileKey } from "~/usage/cache.ts"

import { claudeMessage, claudeThreads } from "./claude.ts"
import { codexMessage, codexThreads } from "./codex.ts"
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

export interface Listed {
  threads: Thread[]
  failed: { profile: string; error: string }[]
}

export function listThreads(profiles: UsageProfile[]): Listed {
  const threads: Thread[] = []
  const failed: Listed["failed"] = []
  for (const p of profiles) {
    try {
      threads.push(...(p.kind === "codex" ? codexThreads(p) : claudeThreads(p)))
    } catch (e) {
      failed.push({ profile: profileKey(p), error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { threads: threads.toSorted((a, b) => b.updatedMs - a.updatedMs), failed }
}

const PREVIEW_BYTES = 1 << 20

export function preview(thread: Thread, count: number): Message[] {
  const read = thread.agent === "codex" ? codexMessage : claudeMessage
  return tailRecords(thread.transcript, PREVIEW_BYTES)
    .map(read)
    .filter((m): m is Message => m !== null)
    .slice(-count)
}
