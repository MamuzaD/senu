import type { Config } from "~/config.ts"
import type { Span } from "~/ui/banner.ts"
import { printHelp } from "~/ui/help.ts"

import { clearSoundOverride, effectiveSoundEnabled, setSoundEnabled } from "./sound-state.ts"

const HELP = `usage: senu sound [status|toggle|on|off|reset]

Shows or changes whether watchers chime, overriding [sound] enabled.

  status           print the current setting
  toggle, on, off  save a choice for every watcher
  reset            go back to [sound] enabled
`

export async function soundCommand(args: string[], config: Config): Promise<number> {
  const [action, ...extra] = args
  if (action === "-h" || action === "--help" || action === "help") {
    await printHelp(process.stdout, HELP)
    return 0
  }
  if (extra.length || (action && !["status", "toggle", "on", "off", "reset"].includes(action))) {
    await printHelp(process.stderr, HELP)
    return 2
  }
  const current = effectiveSoundEnabled(config.sound.enabled)
  if (action === "toggle") setSoundEnabled(!current)
  else if (action === "on" || action === "off") setSoundEnabled(action === "on")
  else if (action === "reset") clearSoundOverride()
  const enabled = effectiveSoundEnabled(config.sound.enabled)
  if (!action || action === "status") {
    console.log(enabled ? "on" : "off")
    return 0
  }
  const [{ banner }, { brand, states }] = await Promise.all([
    import("~/ui/banner.ts"),
    import("~/ui/theme.ts"),
  ])
  const message: Span[] = [
    ["sound ", brand.papyrus],
    enabled ? ["on", states.idle.fg] : ["off", brand.shadow],
  ]
  if (action === "reset") message.push([" · from config", brand.shadow])
  process.stdout.write(banner(message))
  return 0
}
