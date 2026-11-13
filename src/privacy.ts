import { realpathSync } from "node:fs"
import { join, resolve } from "node:path"

import type { Config, Profile } from "~/config.ts"
import { home } from "~/paths.ts"

const canonical = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** Every caller sees every profile until `[privacy] restricted` names some. Then any restricted
 * or unrecognized signal wins over a personal signal. A caller with no agent signal is
 * restricted too, unless `terminal` marks it as the user's own shell: agent shells always carry
 * a signal, but Codex MCP children can lose theirs. */
export function allowedProfiles(
  config: Config,
  env = process.env,
  narrow?: string,
  terminal = false,
): Profile[] {
  const signals: { kind: string; path: string }[] = []
  if (env.CODEX_HOME || env.CODEX_THREAD_ID)
    signals.push({ kind: "codex", path: env.CODEX_HOME || join(home, ".codex") })
  if (
    env.CLAUDE_CONFIG_DIR ||
    env.CLAUDECODE ||
    env.CLAUDE_CODE_SESSION_ID ||
    env.CLAUDE_SESSION_ID
  )
    signals.push({ kind: "claude", path: env.CLAUDE_CONFIG_DIR || join(home, ".claude") })
  const restricted = config.privacy?.restricted ?? []
  if (!restricted.length) return config.profiles.filter((p) => !narrow || p.name === narrow)
  const matched = signals.map((s) =>
    config.profiles.filter((p) => p.kind === s.kind && canonical(p.home) === canonical(s.path)),
  )
  const names = new Set(
    matched
      .flat()
      .filter((p) => restricted.includes(p.name))
      .map((p) => p.name),
  )
  const unknown = (!signals.length && !terminal) || matched.some((ps) => !ps.length)
  return config.profiles.filter((p) => {
    if (narrow && p.name !== narrow) return false
    if (names.size) return names.has(p.name)
    return !unknown || restricted.includes(p.name)
  })
}
