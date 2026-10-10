import { createCliRenderer } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { createRoot } from "@opentui/react"
import type { ReactNode } from "react"

import { UpdateGate, updateGate } from "~/update/gate.tsx"

export async function runApp(
  app: ReactNode | Promise<ReactNode>,
  opts: { useMouse: boolean },
): Promise<void> {
  const { promise: closed, resolve } = Promise.withResolvers<void>()
  const [node, renderer] = await Promise.all([
    app,
    createCliRenderer({ useMouse: opts.useMouse, onDestroy: resolve }),
  ])
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const gate = updateGate(renderer)
  createRoot(renderer).render(
    <KeymapProvider keymap={keymap}>
      <UpdateGate release={gate.release} onUpdate={gate.onUpdate}>
        {node}
      </UpdateGate>
    </KeymapProvider>,
  )
  await closed
  await gate.finish()
}
