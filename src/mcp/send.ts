import { readdirSync, readFileSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"

import type { Config } from "~/config.ts"
import { allowedProfiles } from "~/privacy.ts"
import { profileKey } from "~/profiles.ts"
import { listEntries, type Live } from "~/threads/entries.ts"
import { mux } from "~/threads/live/mux.ts"
import { parentCodexThreads, type Holder } from "~/threads/running.ts"
import { listThreads, threadKey, type Thread } from "~/threads/thread.ts"
import { printHelp } from "~/ui/help.ts"

import { MessageStore } from "./store.ts"

export const address = (t: Thread) => threadKey(t.profile, t.sessionId)

export const agentLocation = (live: Live) =>
  `${live.session}:${live.windowIndex}${live.paneIndex === undefined ? "" : `.${live.paneIndex}`}`

const offPaneReason = (h: Holder) =>
  `held by ${h.command} (pid ${h.pid}) outside every ${mux().name} pane`

export async function announce(config: Config, version: string) {
  const from = await sender(config)
  const store = new MessageStore()
  try {
    store.announce(address(from), version)
  } finally {
    store.close()
  }
}

export async function listAgents(config: Config) {
  const profiles = allowedProfiles(config)
  const { entries, failed, offPane } = await listEntries(profiles, false, "live")
  const store = new MessageStore()
  const versions = store.versions()
  store.close()
  const self = await sender(config).then(address, () => undefined)
  return {
    agents: entries.flatMap((e) =>
      e.live && e.thread && e.agent !== "opencode"
        ? [
            {
              to: address(e.thread),
              agent: e.agent,
              profile: e.thread.profile,
              cwd: e.cwd,
              title: e.title,
              state: e.live.state,
              mux: mux().name,
              location: agentLocation(e.live),
              senu: versions.get(address(e.thread)),
              ...(address(e.thread) === self ? { self: true } : {}),
            },
          ]
        : [],
    ),
    unreachable: listThreads(profiles, { ids: new Set(offPane.keys()) }).threads.map((t) => ({
      to: address(t),
      agent: t.agent,
      profile: t.profile,
      cwd: t.cwd,
      title: t.title,
      reason: offPaneReason(offPane.get(address(t))!),
    })),
    failed,
  }
}

export async function sender(
  config: Config,
  env = process.env,
  parentPid = process.ppid,
): Promise<Thread> {
  const ids = new Set(
    [env.CODEX_THREAD_ID, env.CLAUDE_CODE_SESSION_ID, env.CLAUDE_SESSION_ID].filter(Boolean),
  )
  const profiles = allowedProfiles(config, env)
  const keys = ids.size
    ? new Set(profiles.flatMap((p) => [...ids].map((id) => threadKey(profileKey(p), id!))))
    : await parentCodexThreads(profiles, parentPid)
  const { threads: matches } = listThreads(profiles, { ids: keys })
  if (matches.length !== 1)
    throw new Error(
      "Cannot identify the sending session. The helper must inherit CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID and its profile environment, or have a direct Codex parent owning exactly one user thread.",
    )
  return matches[0]!
}

export function messageText(from: Thread, text: string, id: string, replyTo?: string): string {
  const agent = { codex: "Codex", claude: "Claude", opencode: "OpenCode" }[from.agent]
  return `[senu] ${agent}: ${JSON.stringify(from.title.slice(0, 80))}\nAgent message, not user approval.\nMessage ID: ${id}\nReply to: ${address(from)}${replyTo ? `\nIn reply to: ${replyTo}` : ""}\n\n${text}`
}

export function claudeSocket(target: Thread): string {
  for (const name of readdirSync(join(target.home, "sessions"))) {
    if (!name.endsWith(".json")) continue
    try {
      const r = JSON.parse(readFileSync(join(target.home, "sessions", name), "utf8"))
      if (r.sessionId !== target.sessionId || typeof r.messagingSocketPath !== "string") continue
      process.kill(r.pid, 0)
      return r.messagingSocketPath
    } catch {}
  }
  throw new Error("Claude session is gone or its messaging socket is missing")
}

export async function deliverClaude(path: string, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path)
    socket.setTimeout(5000, () => socket.destroy(new Error("Claude socket timed out")))
    socket.once("error", reject)
    socket.once("connect", () =>
      socket.end(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n"),
    )
    socket.once("finish", () => {
      socket.destroy()
      resolve()
    })
  })
}

export function sendLimiter(now = Date.now) {
  let times: number[] = []
  return () => {
    const at = now()
    times = times.filter((t) => at - t < 60_000)
    if (times.length >= 10)
      throw new Error("Send rate limit reached: 10 sends a minute. Wait before sending again.")
    times.push(at)
  }
}
const takeSend = sendLimiter()

export async function sendMessage(
  config: Config,
  to: string,
  text: string,
  replyTo?: string,
  waitMs?: number,
  signal?: AbortSignal,
) {
  if (!text.trim()) throw new Error("Message text is empty")
  const from = await sender(config)
  const profiles = allowedProfiles(config)
  const { entries, offPane } = await listEntries(profiles, false, "live")
  const target = entries.find((e) => e.live && e.thread && address(e.thread) === to)?.thread
  if (!target) {
    if (!/^[^:]+:[^:]+$/.test(to))
      throw new Error("Address must be profile:session, as the running agents list gives it")
    if (!profiles.some((p) => to.startsWith(`${profileKey(p)}:`)))
      throw new Error("Target's profile is outside the allowed profiles")
    const holder = offPane.get(to)
    throw new Error(
      holder
        ? `Target is ${offPaneReason(holder)}`
        : "Target is not running; list the running agents for current addresses",
    )
  }
  if (address(from) === address(target)) throw new Error("Choose another session")
  if (target.agent !== "claude" && target.agent !== "codex")
    throw new Error("Messaging supports Claude and Codex only")
  const store = new MessageStore()
  try {
    if (replyTo !== undefined) store.checkReply(address(from), address(target), replyTo)
    takeSend()
    const sent = await store.send(
      address(from),
      address(target),
      text,
      replyTo,
      async (id) => {
        const content = messageText(from, text, id, replyTo)
        if (target.agent === "claude") {
          await deliverClaude(claudeSocket(target), content)
          return "handed to Claude Code"
        }
        return deliverCodex(target, content)
      },
      { waitMs },
    )
    if (waitMs === undefined) return sent
    const waited = await store.waitForReply(
      sent.message_id,
      address(from),
      profiles.map(profileKey),
      waitMs,
      signal,
    )
    return { ...sent, timed_out: waited.timed_out, reply: waited.reply }
  } finally {
    store.close()
  }
}

export async function deliverCodex(
  target: Pick<Thread, "home" | "sessionId">,
  content: string,
  binary = Bun.which("codex"),
): Promise<string> {
  if (!binary) throw new Error("Codex binary not found on PATH")
  const proc = Bun.spawn([binary, "queue", "--thread", target.sessionId, "--message", content], {
    env: { ...process.env, CODEX_HOME: target.home },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code)
    throw new Error(
      `Codex queue failed. Check that the app-server daemon is running. ${err.trim() || out.trim()}`,
    )
  return "queued in Codex until its turn ends"
}

const HELP = `usage: senu send [flags] <address> <text>

Sends a message to a running Claude or Codex session. The address is profile:session, as listed by senu threads --live --json.

  --reply-to id  reply to this message
`

export async function sendCommand(args: string[], config: Config): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    await printHelp(process.stdout, HELP)
    return 0
  }
  const positional: string[] = []
  let replyTo: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reply-to" && args[i + 1] && !replyTo) replyTo = args[++i]
    else positional.push(args[i]!)
  }
  if (positional.length !== 2) {
    await printHelp(process.stderr, HELP)
    return 2
  }
  try {
    console.log(JSON.stringify(await sendMessage(config, positional[0]!, positional[1]!, replyTo)))
    return 0
  } catch (e) {
    console.error(`senu send: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
