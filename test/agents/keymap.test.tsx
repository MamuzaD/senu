import { afterEach, expect, test } from "bun:test"

import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { createRoot } from "@opentui/react"
import { act } from "react"

import type { Collected, Collector } from "~/agents/collect.ts"
import { Picker } from "~/agents/picker.tsx"

let destroy: (() => void) | null = null
afterEach(() => {
  destroy?.()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
})

test("picker keymap moves and waits for kill confirmation", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 80, height: 22 })
  destroy = () => act(() => t.renderer.destroy())
  const initial: Collected = {
    daemon: "dead",
    rows: ["one", "two"].map((label, i) => ({
      windowId: `@${i}`,
      session: "test",
      windowIndex: i,
      windowName: label,
      paneId: `%${i}`,
      agent: "codex" as const,
      state: "idle" as const,
      activity: 0,
      label,
      source: "live" as const,
    })),
  }
  const collector = { collect: async () => initial } as Collector
  const keymap = createDefaultOpenTuiKeymap(t.renderer)
  act(() =>
    createRoot(t.renderer).render(
      <KeymapProvider keymap={keymap}>
        <Picker collector={collector} initial={initial} raiseGhosttyTab={false} />
      </KeymapProvider>,
    ),
  )
  await act(() => t.renderOnce())

  act(() => t.mockInput.pressKey("J", { shift: true }))
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toMatch(/▌.*two/)

  act(() => t.mockInput.pressKey("g"))
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toMatch(/▌.*one/)

  act(() => t.mockInput.pressKey("G", { shift: true }))
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toMatch(/▌.*two/)

  act(() => t.mockInput.pressKey("x"))
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("kill this codex?")

  act(() => t.mockInput.pressKey("a"))
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).not.toContain("kill this codex?")
})
