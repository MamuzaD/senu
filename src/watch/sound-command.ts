import type { Config } from "~/config.ts"

import { clearSoundOverride, effectiveSoundEnabled, setSoundEnabled } from "./sound-state.ts"

const HELP = `usage: senu sound [status|toggle|on|off|reset]

status prints the effective sound setting. toggle, on and off save a runtime
choice that applies to every watcher; reset returns to [sound] enabled in
config.toml. Custom chimes and focused-window sounds are set in [sound].
`

export async function soundCommand(args: string[], config: Config): Promise<number> {
  const [action, ...extra] = args
  if (action === "-h" || action === "--help" || action === "help") {
    process.stdout.write(HELP)
    return 0
  }
  if (extra.length || (action && !["status", "toggle", "on", "off", "reset"].includes(action))) {
    process.stderr.write(HELP)
    return 2
  }
  const current = effectiveSoundEnabled(config.sound.enabled)
  if (action === "toggle") setSoundEnabled(!current)
  else if (action === "on" || action === "off") setSoundEnabled(action === "on")
  else if (action === "reset") clearSoundOverride()
  console.log(effectiveSoundEnabled(config.sound.enabled) ? "on" : "off")
  return 0
}
