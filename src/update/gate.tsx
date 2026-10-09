import type { CliRenderer } from "@opentui/core"
import { useState, type ReactNode } from "react"

import { compiled } from "~/paths.ts"

import { installedBinary, runUpdate } from "./command.ts"
import { UpdatePrompt, type UpdateChoice } from "./prompt.tsx"
import { dismiss, promptRelease } from "./release.ts"

/** Shows the update prompt for `release` in front of a popup, then the popup itself. */
export function UpdateGate({
  release,
  onUpdate,
  onDismiss = dismiss,
  children,
}: {
  release: string | null
  onUpdate: () => void
  onDismiss?: (latest: string) => void
  children: ReactNode
}) {
  const [asking, setAsking] = useState(release != null)
  if (!asking || !release) return children
  const choose = (choice: UpdateChoice) => {
    if (choice === "update") return onUpdate()
    if (choice === "dismiss") onDismiss(release)
    setAsking(false)
  }
  return <UpdatePrompt latest={release} onChoose={choose} />
}

async function waitForKey() {
  process.stdout.write("\npress any key to close")
  process.stdin.setRawMode(true)
  process.stdin.resume()
  // Drop keys typed during the install, so they don't close this at once.
  await Bun.sleep(50)
  await new Promise((resolve) => process.stdin.once("data", resolve))
  // Hand the terminal back cooked, or a shell reading after us never sees Enter.
  process.stdin.setRawMode(false)
  process.stdin.pause()
  process.stdout.write("\n")
}

/**
 * What a popup needs to ask about an update: the release to offer, if any, and
 * what "update now" does. Only a compiled senu that install.sh could replace
 * asks; from source there's no binary to replace.
 */
export function updateGate(renderer: CliRenderer) {
  const release = compiled && installedBinary() ? promptRelease() : null
  let updating = false
  return {
    release,
    onUpdate: () => {
      updating = true
      renderer.destroy()
    },
    /** Once the popup has closed: runs a chosen update and exits with its code. */
    async finish() {
      if (!updating || !release) return
      const code = await runUpdate(release)
      // tmux closes the popup when senu exits; leave the install output up until a key.
      await waitForKey()
      process.exit(code)
    },
  }
}
