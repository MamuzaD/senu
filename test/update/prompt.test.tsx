import { afterEach, describe, expect, test } from "bun:test"

import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { createRoot } from "@opentui/react"
import { act } from "react"
import type { ReactNode } from "react"

import { UpdateGate } from "~/update/gate.tsx"
import { UpdatePrompt, type UpdateChoice } from "~/update/prompt.tsx"

import { version } from "../../package.json"

let destroy: (() => void) | null = null
afterEach(() => {
  destroy?.()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
})

async function render(node: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 120, height: 16 })
  destroy = () => act(() => t.renderer.destroy())
  act(() =>
    createRoot(t.renderer).render(
      <KeymapProvider keymap={createDefaultOpenTuiKeymap(t.renderer)}>{node}</KeymapProvider>,
    ),
  )
  await act(() => t.renderOnce())
  return t
}

async function mount() {
  const chosen: UpdateChoice[] = []
  const t = await render(<UpdatePrompt latest="0.2.0" onChoose={(c) => chosen.push(c)} />)
  return { t, chosen }
}

/** A lone escape is only read as a key once no sequence follows it. */
const pressEscape = (t: Awaited<ReturnType<typeof render>>) =>
  act(async () => {
    t.mockInput.pressEscape()
    await Bun.sleep(100)
  })

test("shows both versions and the command it runs", async () => {
  const { t } = await mount()
  const frame = t.captureCharFrame()
  expect(frame).toContain(`update available · ${version} → 0.2.0`)
  expect(frame).toContain("› 1. update now")
  expect(frame).toContain(
    "runs curl -fsSL https://raw.githubusercontent.com/MamuzaD/senu/v0.2.0/install.sh | sh",
  )
  expect(frame).toContain("  2. skip")
  expect(frame).toContain("  3. skip until next version")
})

test("enter picks the highlighted choice", async () => {
  const { t, chosen } = await mount()
  act(() => t.mockInput.pressEnter())
  act(() => t.mockInput.pressArrow("down"))
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("› 2. skip")
  act(() => t.mockInput.pressEnter())
  act(() => t.mockInput.pressArrow("down"))
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("› 3. skip until next version")
  act(() => t.mockInput.pressEnter())
  expect(chosen).toEqual(["update", "skip", "dismiss"])
})

test("numbers choose directly and escape skips", async () => {
  const { t, chosen } = await mount()
  act(() => t.mockInput.pressKey("3"))
  act(() => t.mockInput.pressKey("2"))
  act(() => t.mockInput.pressKey("1"))
  await pressEscape(t)
  expect(chosen).toEqual(["dismiss", "skip", "update", "skip"])
})

describe("UpdateGate", () => {
  const gate = (release: string | null) => {
    const calls = { update: 0, dismissed: [] as string[] }
    const node = (
      <UpdateGate
        release={release}
        onUpdate={() => calls.update++}
        onDismiss={(v) => calls.dismissed.push(v)}
      >
        <text>the popup</text>
      </UpdateGate>
    )
    return { calls, node }
  }

  test("no release goes straight to the popup", async () => {
    const t = await render(gate(null).node)
    expect(t.captureCharFrame()).toContain("the popup")
  })

  test("skip shows the popup and remembers nothing", async () => {
    const { calls, node } = gate("0.2.0")
    const t = await render(node)
    expect(t.captureCharFrame()).not.toContain("the popup")
    await pressEscape(t)
    await act(() => t.renderOnce())
    expect(t.captureCharFrame()).toContain("the popup")
    expect(calls).toEqual({ update: 0, dismissed: [] })
  })

  test("skip until next version dismisses this release", async () => {
    const { calls, node } = gate("0.2.0")
    const t = await render(node)
    act(() => t.mockInput.pressKey("3"))
    await act(() => t.renderOnce())
    expect(t.captureCharFrame()).toContain("the popup")
    expect(calls).toEqual({ update: 0, dismissed: ["0.2.0"] })
  })

  test("update now hands off without showing the popup", async () => {
    const { calls, node } = gate("0.2.0")
    const t = await render(node)
    act(() => t.mockInput.pressKey("1"))
    await act(() => t.renderOnce())
    expect(t.captureCharFrame()).not.toContain("the popup")
    expect(calls).toEqual({ update: 1, dismissed: [] })
  })
})
