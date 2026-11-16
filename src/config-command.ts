import { existsSync } from "node:fs"

import { defaultConfig, loadConfig, type Config } from "./config.ts"
import { configPath } from "./paths.ts"
import { printHelp } from "./ui/help.ts"

const HELP = `usage: senu config [--defaults]

Prints the config path and effective settings as TOML, including environment overrides.
Does not create or modify the config file.

  --defaults  print default options without reading your config or SENU_SCENE
  --help      show this help
`

const quote = (s: string) => JSON.stringify(s)

/** Use file-format keys so the output can be saved as config.toml. */
export function configToml(config: Config): string {
  const { usage, threads, sound, privacy, profiles } = config
  return [
    "# Profiles: codex, claude, or opencode. Default homes follow CODEX_HOME and XDG_DATA_HOME.",
    ...profiles.flatMap((p) => [
      "[[profiles]]",
      `kind = ${quote(p.kind)}`,
      `name = ${quote(p.name)}`,
      `home = ${quote(p.home)}`,
      "",
    ]),
    "[usage]",
    "# Scene: night, dawn, day, dusk, or auto. SENU_SCENE overrides this.",
    `scene = ${quote(usage.scene)}`,
    "",
    "[threads]",
    `preview = ${threads.preview}`,
    `live_preview = ${threads.livePreview}`,
    `recent_days = ${threads.recentDays}`,
    "# Resume: auto or window.",
    `resume = ${quote(threads.resume)}`,
    `raise_ghostty_tab = ${threads.raiseGhosttyTab}`,
    "",
    "[sound]",
    `enabled = ${sound.enabled}`,
    `always = ${sound.always}`,
    "# Empty paths use system sounds or generated chimes.",
    `done = ${quote(sound.done)}`,
    `request = ${quote(sound.request)}`,
    "",
    "[privacy]",
    "# Profile names restricted for search and MCP callers; empty disables restrictions.",
    `restricted = [${(privacy?.restricted ?? []).map(quote).join(", ")}]`,
    "",
  ].join("\n")
}

export async function configCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    await printHelp(process.stdout, HELP)
    return 0
  }
  if (args.some((a) => a !== "--defaults")) {
    await printHelp(process.stderr, HELP)
    return 2
  }
  const defaults = args.includes("--defaults")
  const config = defaults ? defaultConfig() : loadConfig()
  const header = defaults
    ? "# Default options. Profile homes use the current environment."
    : `# Config: ${quote(configPath)}${existsSync(configPath) ? "" : " (not found; using defaults and environment overrides)"}`
  process.stdout.write(`${header}\n\n${configToml(config)}`)
  return 0
}
