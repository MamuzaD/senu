import { afterEach, expect, test } from "bun:test"

import { TextAttributes } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { createRoot } from "@opentui/react"
import { act } from "react"

import { UsagePopup } from "~/usage/popup.tsx"

let destroy: (() => void) | null = null
afterEach(() => {
  destroy?.()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
})

test("usage popup keymap switches views, ranges, and breakdowns", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 96, height: 32 })
  destroy = () => act(() => t.renderer.destroy())
  const keymap = createDefaultOpenTuiKeymap(t.renderer)
  act(() =>
    createRoot(t.renderer).render(
      <KeymapProvider keymap={keymap}>
        <UsagePopup profiles={[]} time="day" />
      </KeymapProvider>,
    ),
  )
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("c cost · q quit")

  const underlined = () =>
    t
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .filter((span) => span.attributes & TextAttributes.UNDERLINE)
      .map((span) => span.text)

  act(() => t.mockInput.pressKey("C", { shift: true }))
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("today  7d  30d")
  expect(t.captureCharFrame()).toContain("←/→ range · ↑/↓ breakdown · tab limits · q quit")
  expect(underlined()).toContain("today")

  act(() => t.mockInput.pressArrow("right"))
  await act(() => t.renderOnce())
  expect(underlined()).toContain("7d")

  act(() => t.mockInput.pressKey("]"))
  await act(() => t.renderOnce())
  expect(underlined()).toContain("30d")

  act(() => t.mockInput.pressKey("h"))
  await act(() => t.renderOnce())
  expect(underlined()).toContain("7d")

  act(() => t.mockInput.pressKey("L", { shift: true }))
  await act(() => t.renderOnce())
  expect(underlined()).toContain("30d")

  act(() => t.mockInput.pressArrow("down"))
  await act(() => t.renderOnce())
  expect(underlined()).toContain("by model")

  act(() => t.mockInput.pressTab())
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("c cost · q quit")
})
