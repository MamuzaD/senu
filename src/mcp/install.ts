import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import type { Config, Profile } from "~/config.ts"
import { home, selfCommand } from "~/paths.ts"
import { profileKey } from "~/profiles.ts"

const SENU = `(?:senu|"senu"|'senu')`
const TABLE = new RegExp(String.raw`^\[\s*mcp_servers\s*\.\s*${SENU}\s*(\.[^\]]+)?\]`)
const ROOT_KEY = new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${SENU}\s*[.=]`)
const SERVERS_KEY = new RegExp(String.raw`^\s*${SENU}\s*[.=]`)

/** Everything in a config besides senu's entry, or undefined when it does not parse. */
function others(toml: string): unknown {
  try {
    const config = Bun.TOML.parse(toml) as { mcp_servers?: Record<string, unknown> }
    delete config.mcp_servers?.senu
    if (config.mcp_servers && !Object.keys(config.mcp_servers).length) delete config.mcp_servers
    return config
  } catch {
    return undefined
  }
}

/** Codex strips an MCP server's environment, so its table pins the profile home and forwards
 * the variables Rex discovery reads. Replaces any earlier `senu` table. */
export function codexConfig(text: string, command: string[], codexHome: string): string {
  const kept: string[] = []
  let ours = false
  let key: RegExp | undefined = ROOT_KEY
  for (const line of text.split("\n")) {
    const head = line.trimStart()
    if (head.startsWith("[")) {
      ours = TABLE.test(head)
      key = /^\[\s*mcp_servers\s*\]/.test(head) ? SERVERS_KEY : undefined
    }
    if (!ours && !key?.test(line)) kept.push(line)
  }
  const rest = kept.join("\n").trimEnd()
  const table = [
    "[mcp_servers.senu]",
    `command = ${JSON.stringify(command[0])}`,
    `args = ${JSON.stringify([...command.slice(1), "mcp"])}`,
    'env_vars = ["REX_SESSION", "REX_BIN_DIR"]',
    "",
    "[mcp_servers.senu.env]",
    `CODEX_HOME = ${JSON.stringify(codexHome)}`,
  ].join("\n")
  const next = `${rest ? `${rest}\n\n` : ""}${table}\n`
  const before = others(text)
  if (before !== undefined && !Bun.deepEquals(before, others(next)))
    throw new Error("config.toml defines senu in a form this cannot replace; remove it and retry")
  return next
}

function replaceFile(path: string, text: string) {
  const target = existsSync(path) ? realpathSync(path) : path
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, text, existsSync(target) ? { mode: statSync(target).mode } : {})
  renameSync(tmp, target)
}

async function claude(p: Profile, command: string[], binary: string): Promise<void> {
  // Claude keeps the default profile's servers in ~/.claude.json only while this is unset.
  const { CLAUDE_CONFIG_DIR: _, ...env } = process.env
  if (p.home !== join(home, ".claude")) env.CLAUDE_CONFIG_DIR = p.home
  const run = async (...args: string[]) => {
    const proc = Bun.spawn([binary, "mcp", ...args], { env, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code) throw new Error(err.trim() || out.trim())
  }
  // `add` keeps an existing entry, which would leave a stale binary path in place. `remove`
  // fails when there is none.
  await run("remove", "--scope", "user", "senu").catch(() => {})
  await run("add", "--scope", "user", "senu", "--", ...command, "mcp")
}

export async function installCommand(
  config: Config,
  command = selfCommand(),
  binaries = { claude: Bun.which("claude"), codex: Bun.which("codex") },
): Promise<number> {
  let failed = false
  for (const p of config.profiles) {
    if (p.kind === "opencode") continue
    let status = "registered"
    try {
      if (!existsSync(p.home)) status = "skipped, no such folder"
      else if (!binaries[p.kind]) status = `skipped, ${p.kind} is not installed`
      else if (p.kind === "claude") await claude(p, command, binaries.claude!)
      else {
        const path = join(p.home, "config.toml")
        const text = existsSync(path) ? readFileSync(path, "utf8") : ""
        replaceFile(path, codexConfig(text, command, p.home))
      }
    } catch (e) {
      failed = true
      status = `failed: ${e instanceof Error ? e.message : String(e)}`
    }
    console.log(`${profileKey(p)}  ${status}`)
  }
  console.log("Restart running sessions to load it.")
  return failed ? 1 : 0
}
