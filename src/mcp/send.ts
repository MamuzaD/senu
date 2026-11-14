import { readdirSync, readFileSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"

import type { Config } from "~/config.ts"
import { allowedProfiles } from "~/privacy.ts"
import { listEntries, type Live } from "~/threads/entries.ts"
import { mux } from "~/threads/live/mux.ts"
import { parentCodexThreads } from "~/threads/running.ts"
import { listThreads, threadKey, type Thread } from "~/threads/thread.ts"
import { printHelp } from "~/ui/help.ts"

import { MessageStore } from "./store.ts"

export const address = (t: Thread) => threadKey(t.profile, t.sessionId)

export const agentLocation = (live: Live) =>
  `${live.session}:${live.windowIndex}${live.paneIndex === undefined ? "" : `.${live.paneIndex}`}`

export async function listAgents(config: Config) {
  const { entries, failed } = await listEntries(allowedProfiles(config), false, "live")
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
            },
          ]
        : [],
    ),
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
    ? new Set(profiles.flatMap((p) => [...ids].map((id) => threadKey(`${p.kind}-${p.name}`, id!))))
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
      throw new Error("Send rate limit reached. Wait a minute before sending again.")
    times.push(at)
  }
}
const takeSend = sendLimiter()

export async function sendMessage(config: Config, to: string, text: string, replyTo?: string) {
  if (!text.trim()) throw new Error("Message text is empty")
  const from = await sender(config)
  const profiles = allowedProfiles(config)
  const { entries } = await listEntries(profiles, false, "live")
  const target = entries.find((e) => e.live && e.thread && address(e.thread) === to)?.thread
  if (!target)
    throw new Error(
      "Target is gone, outside the allowed profiles, or not running in a supported terminal",
    )
  if (address(from) === address(target)) throw new Error("Choose another session")
  if (target.agent !== "claude" && target.agent !== "codex")
    throw new Error("Messaging supports Claude and Codex only")
  takeSend()
  const store = new MessageStore()
  try {
    return await store.send(address(from), address(target), text, replyTo, async (id) => {
      const content = messageText(from, text, id, replyTo)
      if (target.agent === "claude") {
        await deliverClaude(claudeSocket(target), content)
        return "handed to Claude Code"
      }
      return deliverCodex(target, content)
    })
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
  return "queued in Codex"
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
