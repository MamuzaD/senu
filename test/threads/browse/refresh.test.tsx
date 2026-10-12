import { afterEach, expect, spyOn, test } from "bun:test"

import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { createRoot } from "@opentui/react"
import { act } from "react"

import { Browser } from "~/threads/browse/browser.tsx"
import type { Entry } from "~/threads/entries.ts"

const RECENT_MS = 3 * 24 * 60 * 60 * 1000

let destroy: (() => void) | null = null
afterEach(() => {
  destroy?.()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
})

test.each(["pane changed", "agent exited"])("Enter uses refreshed data when %s", async (change) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 100, height: 22 })
  destroy = () => act(() => t.renderer.destroy())
  const entry: Entry = {
    agent: "codex",
    title: "same thread",
    cwd: "/p",
    updatedMs: Date.now(),
    thread: {
      sessionId: "same-id",
      agent: "codex",
      profile: "codex-default",
      home: "/h",
      title: "same thread",
      cwd: "/p",
      updatedMs: Date.now(),
      transcript: "/missing-transcript",
    },
    live: { paneId: "%1", windowId: "@1", windowIndex: 1, session: "s", state: "idle" },
  }
  const updated: Entry = {
    ...entry,
    live: change === "agent exited" ? null : { ...entry.live!, paneId: "%2" },
  }
  const opened: Entry[] = []
  const keymap = createDefaultOpenTuiKeymap(t.renderer)
  const registered = spyOn(keymap, "registerLayer")
  act(() =>
    createRoot(t.renderer).render(
      <KeymapProvider keymap={keymap}>
        <Browser
          initial={[entry]}
          load={async () => [updated]}
          watch={async () => ({ merge: (es) => es, scouting: false })}
          live={false}
          preview={true}
          recentMs={RECENT_MS}
          jump={async () => {}}
          onOpen={(e) => void opened.push(e)}
        />
      </KeymapProvider>,
    ),
  )
  await act(() => t.renderOnce())
  const registrations = registered.mock.calls.length
  await act(() => t.renderOnce())
  expect(registered.mock.calls.length).toBe(registrations)

  await act(async () => {
    t.mockInput.pressKey("r")
    await Promise.resolve()
  })
  await act(() => t.renderOnce())
  act(() => t.mockInput.pressEnter())
  expect(opened).toEqual([updated])
})

test.each([4, 5, 6])(
  "browser stays responsive at %i rows and recovers after resizing",
  async (height) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const t = await createTestRenderer({ width: 100, height })
    destroy = () => act(() => t.renderer.destroy())
    const initial = ["first", "second"].map((title, i): Entry => ({
      thread: null,
      agent: "codex",
      title,
      cwd: "/p",
      updatedMs: 200 - i,
      live: { state: "idle", paneId: `%${i}`, windowId: `@${i}`, windowIndex: 1, session: "s" },
    }))
    const opened: Entry[] = []
    const keymap = createDefaultOpenTuiKeymap(t.renderer)
    act(() =>
      createRoot(t.renderer).render(
        <KeymapProvider keymap={keymap}>
          <Browser
            initial={initial}
            load={async () => initial}
            watch={async () => ({ merge: (es) => es, scouting: false })}
            live={false}
            preview={true}
            recentMs={RECENT_MS}
            jump={async () => {}}
            onOpen={(e) => void opened.push(e)}
          />
        </KeymapProvider>,
      ),
    )
    await act(() => t.renderOnce())
    act(() => t.mockInput.pressKey("j"))
    await act(() => t.renderOnce())
    act(() => t.resize(100, 22))
    await act(() => t.renderOnce())
    expect(t.captureCharFrame()).toMatch(/▌.*second/)
    act(() => t.mockInput.pressEnter())
    expect(opened).toEqual([initial[1]!])
  },
)
