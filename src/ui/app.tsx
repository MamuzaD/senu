import { setTimeout as sleep } from "node:timers/promises"
import { WriteStream } from "node:tty"

import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { createRoot } from "@opentui/react"
import type { ReactNode } from "react"

import { UpdateGate, updateGate } from "~/update/gate.tsx"

async function syncStartupSize(renderer: CliRenderer) {
  // Rex can size a new popup after Bun has cached the initial PTY dimensions.
  for (const delay of [0, 50, 150, 300, 600]) {
    if (delay) await sleep(delay, undefined, { ref: false })
    if (renderer.isDestroyed) return
    const [width, height] = new WriteStream(process.stdout.fd).getWindowSize()
    if (width > 0 && height > 0 && (width !== renderer.width || height !== renderer.height))
      renderer.resize(width, height)
  }
}

export async function runApp(
  app: ReactNode | Promise<ReactNode>,
  opts: { useMouse: boolean; syncStartupSize?: boolean },
): Promise<void> {
  const { promise: closed, resolve } = Promise.withResolvers<void>()
  const [node, renderer] = await Promise.all([
    app,
    createCliRenderer({ useMouse: opts.useMouse, onDestroy: resolve }),
  ])
  const keymap = createDefaultOpenTuiKeymap(renderer)
  // On destroy the keymap drops its extra fields before its layers, so a layer re-registered just
  // before quitting warns about `enabled` and `desc` on the way out; those mean nothing by then
  keymap.on("warning", ({ code, message }) => {
    if (!renderer.isDestroyed) console.warn(`[${code}] ${message}`)
  })
  const gate = updateGate(renderer)
  createRoot(renderer).render(
    <KeymapProvider keymap={keymap}>
      <UpdateGate release={gate.release} onUpdate={gate.onUpdate}>
        {node}
      </UpdateGate>
    </KeymapProvider>,
  )
  if (opts.syncStartupSize && process.stdout.isTTY) void syncStartupSize(renderer)
  await closed
  await gate.finish()
}
