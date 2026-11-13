import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadConfig, type Config } from "~/config.ts"

const dirs: string[] = []
/** A config w/ a personal and two work profiles, each in its own temp home */
export function setup() {
  const root = mkdtempSync(join(tmpdir(), "senu-bridge-"))
  dirs.push(root)
  const config = loadConfig(join(root, "missing"))
  config.profiles = [
    { kind: "codex", name: "personal", home: join(root, "codex") },
    { kind: "codex", name: "work", home: join(root, "codex-work") },
    { kind: "claude", name: "work", home: join(root, "claude-work") },
  ]
  config.privacy = { restricted: ["work"] }
  for (const p of config.profiles) mkdirSync(p.home)
  return { root, config, env: { CODEX_HOME: config.profiles[0]!.home } }
}
export function cleanup() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export const record = (text: string, role = "user") => ({
  type: "response_item",
  payload: { type: "message", role, content: [{ type: "input_text", text }] },
})
export function rollout(
  config: Config,
  index: number,
  name: string,
  records: unknown[],
  compressed = false,
) {
  const dir = join(config.profiles[index]!.home, "sessions", "2026", "11", "13")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.jsonl`)
  const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n"
  writeFileSync(
    compressed ? `${path}.zst` : path,
    compressed ? Bun.zstdCompressSync(Buffer.from(text)) : text,
  )
  return compressed ? `${path}.zst` : path
}
