import { afterEach, expect, spyOn, test } from "bun:test"

import { createTestRenderer } from "@opentui/core/testing"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider } from "@opentui/keymap/react"
import { createRoot } from "@opentui/react"
import { act } from "react"

import { Browser } from "~/threads/browse/browser.tsx"
import { agentEntry, type Entry, type Scope } from "~/threads/entries.ts"

const RECENT_MS = 3 * 24 * 60 * 60 * 1000

let destroy: (() => void) | null = null
afterEach(() => {
  destroy?.()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
})

test("live mode moves, waits for kill confirmation, flips with tab, and jumps", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 100, height: 22 })
  destroy = () => act(() => t.renderer.destroy())
  const agents = ["one", "two"].map((label, i) =>
    agentEntry(
      {
        windowId: `@${i}`,
        session: "test",
        windowIndex: i,
        windowName: label,
        paneId: `%${i}`,
        agent: "codex",
        state: "idle",
        activity: 2 - i,
        label,
        source: "live",
      },
      "/p",
    ),
  )
  const saved: Entry = { ...agents[0]!, title: "saved", live: null, updatedMs: Date.now() }
  const initial = [...agents, saved]
  const jumped: Entry[] = []
  const keymap = createDefaultOpenTuiKeymap(t.renderer)
  act(() =>
    createRoot(t.renderer).render(
      <KeymapProvider keymap={keymap}>
        <Browser
          initial={initial}
          load={async () => initial}
          watch={async () => ({ merge: (es) => es, scouting: false })}
          live
          preview={false}
          recentMs={RECENT_MS}
          jump={async (e) => void jumped.push(e)}
          onOpen={() => {}}
        />
      </KeymapProvider>,
    ),
  )
  const press = async (key: string, shift = false) => {
    act(() => t.mockInput.pressKey(key, { shift }))
    await act(() => t.renderOnce())
  }
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("agents")
  expect(t.captureCharFrame()).toContain("test:1")
  expect(t.captureCharFrame()).not.toContain("saved")
  expect(t.captureCharFrame()).not.toContain("no saved thread yet")
  await press("p")
  expect(t.captureCharFrame()).toContain("no saved thread yet")
  await press("p")
  expect(t.captureCharFrame()).not.toContain("no saved thread yet")

  await press("j")
  expect(t.captureCharFrame()).toMatch(/▌.*two/)
  await press("g")
  expect(t.captureCharFrame()).toMatch(/▌.*one/)
  await press("G", true)
  expect(t.captureCharFrame()).toMatch(/▌.*two/)

  await press("x")
  expect(t.captureCharFrame()).toContain("kill this codex")
  await press("a")
  expect(t.captureCharFrame()).not.toContain("kill this codex")

  act(() => t.mockInput.pressTab())
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("saved")
  act(() => t.mockInput.pressTab())
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).not.toContain("saved")

  act(() => t.mockInput.pressEnter())
  await act(() => t.renderOnce())
  expect(jumped.map((e) => e.title)).toEqual(["two"])
})

test("live limits apply after filtering and still hold after a watch update", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 100, height: 22 })
  destroy = () => act(() => t.renderer.destroy())
  const row = (title: string, paneId: string, updatedMs: number, live = true): Entry => ({
    thread: null,
    agent: "codex",
    title,
    cwd: "/p",
    updatedMs,
    live: live
      ? { state: "idle", paneId, windowId: `@${paneId}`, windowIndex: 1, session: "s" }
      : null,
  })
  const initial = [
    row("newer saved", "", 30, false),
    row("first agent", "%1", 20),
    row("second agent", "%2", 10),
  ]
  const fresh = row("fresh agent", "%3", 40)
  const keymap = createDefaultOpenTuiKeymap(t.renderer)
  act(() =>
    createRoot(t.renderer).render(
      <KeymapProvider keymap={keymap}>
        <Browser
          initial={initial}
          load={async () => initial}
          watch={async () => {
            await Bun.sleep(1)
            return { merge: (es) => [fresh, ...es], scouting: false }
          }}
          live
          preview={false}
          recentMs={RECENT_MS}
          limit={1}
          jump={async () => {}}
          onOpen={() => {}}
        />
      </KeymapProvider>,
    ),
  )
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("first agent")
  expect(t.captureCharFrame()).not.toContain("second agent")

  act(() => t.mockInput.pressTab())
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("newer saved")
  expect(t.captureCharFrame()).not.toContain("first agent")
  act(() => t.mockInput.pressTab())
  await act(() => t.renderOnce())

  await act(async () => {
    t.mockInput.pressKey("r")
    await Bun.sleep(10)
  })
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("fresh agent")
  expect(t.captureCharFrame()).toContain("refreshed")
  expect(t.captureCharFrame()).not.toContain("first agent")
  expect(t.captureCharFrame()).not.toContain("second agent")
})

test("live limits prioritize blocked agents over newer idle agents", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 100, height: 22 })
  destroy = () => act(() => t.renderer.destroy())
  const initial: Entry[] = [
    {
      thread: null,
      agent: "codex",
      title: "new idle",
      cwd: "/p",
      updatedMs: 200,
      live: { state: "idle", paneId: "%1", windowId: "@1", windowIndex: 1, session: "s" },
    },
    {
      thread: null,
      agent: "codex",
      title: "old blocked",
      cwd: "/p",
      updatedMs: 100,
      live: { state: "blocked", paneId: "%2", windowId: "@2", windowIndex: 1, session: "s" },
    },
  ]
  const jumped: Entry[] = []
  const keymap = createDefaultOpenTuiKeymap(t.renderer)
  act(() =>
    createRoot(t.renderer).render(
      <KeymapProvider keymap={keymap}>
        <Browser
          initial={initial}
          load={async () => initial}
          watch={async () => ({ merge: (es) => es, scouting: false })}
          live
          preview={false}
          recentMs={RECENT_MS}
          limit={1}
          jump={async (e) => void jumped.push(e)}
          onOpen={() => {}}
        />
      </KeymapProvider>,
    ),
  )
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("old blocked")
  expect(t.captureCharFrame()).not.toContain("new idle")
  act(() => t.mockInput.pressEnter())
  expect(jumped).toEqual([initial[1]!])
})

test("a partial start loads every thread right away, with the older ones' place held", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 100, height: 22 })
  destroy = () => act(() => t.renderer.destroy())
  const running: Entry = {
    thread: { sessionId: "t", profile: "codex-p" } as Entry["thread"],
    agent: "codex",
    title: "running thread",
    cwd: "/p",
    updatedMs: Date.now(),
    live: { state: "idle", paneId: "%1", windowId: "@1", windowIndex: 1, session: "s" },
  }
  const older: Entry = {
    ...running,
    thread: { sessionId: "old", profile: "codex-p" } as Entry["thread"],
    title: "older thread",
    updatedMs: Date.now() - 10 * RECENT_MS,
    live: null,
  }
  const scopes: Scope[] = []
  const loaded = Promise.withResolvers<Entry[]>()
  const keymap = createDefaultOpenTuiKeymap(t.renderer)
  act(() =>
    createRoot(t.renderer).render(
      <KeymapProvider keymap={keymap}>
        <Browser
          initial={[running]}
          load={(scope) => {
            scopes.push(scope)
            return loaded.promise
          }}
          watch={async () => ({ merge: (es) => es, scouting: false })}
          live={false}
          preview={true}
          recentMs={RECENT_MS}
          partial
          jump={async () => {}}
          onOpen={() => {}}
        />
      </KeymapProvider>,
    ),
  )
  await act(() => t.renderOnce())
  expect(scopes).toEqual(["all"])
  expect(t.captureCharFrame()).toContain("running thread")
  expect(t.captureCharFrame()).toContain("older …")
  expect(t.captureCharFrame()).toContain("threads  …")
  await act(async () => loaded.resolve([running, older]))
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("running thread")
  expect(t.captureCharFrame()).toContain("older 1")
  expect(t.captureCharFrame()).toContain("threads  2")
})

test("the same session in two profiles is two rows the cursor can reach", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 100, height: 22 })
  destroy = () => act(() => t.renderer.destroy())
  const copy = (profile: string, updatedMs: number): Entry => ({
    thread: { sessionId: "same", profile } as Entry["thread"],
    agent: "claude",
    title: profile,
    cwd: "/",
    updatedMs,
    live: null,
  })
  const opened: Entry[] = []
  const keymap = createDefaultOpenTuiKeymap(t.renderer)
  act(() =>
    createRoot(t.renderer).render(
      <KeymapProvider keymap={keymap}>
        <Browser
          initial={[copy("claude-work", Date.now()), copy("claude-personal", Date.now() - 1000)]}
          load={async () => []}
          watch={async () => ({ merge: (es) => es, scouting: false })}
          live={false}
          preview={false}
          recentMs={RECENT_MS}
          jump={async () => {}}
          onOpen={(e) => opened.push(e)}
        />
      </KeymapProvider>,
    ),
  )
  await act(() => t.renderOnce())
  act(() => t.mockInput.pressKey("j"))
  act(() => t.mockInput.pressEnter())
  expect(opened.map((e) => e.title)).toEqual(["claude-personal"])
})

test("Esc clears a filter before it quits, and a gone folder is said instead of opened", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 100, height: 22 })
  destroy = () => act(() => t.renderer.destroy())
  const entry = (title: string, cwd: string): Entry => ({
    thread: { sessionId: title, profile: "claude-p" } as Entry["thread"],
    agent: "claude",
    title,
    cwd,
    updatedMs: Date.now(),
    live: null,
  })
  const opened: Entry[] = []
  const keymap = createDefaultOpenTuiKeymap(t.renderer)
  act(() =>
    createRoot(t.renderer).render(
      <KeymapProvider keymap={keymap}>
        <Browser
          initial={[entry("kept", "/"), entry("moved", "/gone/away")]}
          load={async () => []}
          watch={async () => ({ merge: (es) => es, scouting: false })}
          live={false}
          preview={false}
          recentMs={RECENT_MS}
          jump={async () => {}}
          onOpen={(e) => opened.push(e)}
        />
      </KeymapProvider>,
    ),
  )
  const destroyed = spyOn(t.renderer, "destroy")
  await act(() => t.renderOnce())
  for (const key of ["/", "m", "o", "v", "e", "d"]) act(() => t.mockInput.pressKey(key))
  act(() => t.mockInput.pressEnter())
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).not.toContain("kept")

  act(() => t.mockInput.pressEnter())
  await act(() => t.renderOnce())
  expect(opened).toEqual([])
  expect(t.captureCharFrame()).toContain("/gone/away no longer exists")

  const escape = () =>
    act(async () => {
      t.mockInput.pressEscape()
      await Bun.sleep(50)
    })
  await escape()
  await act(() => t.renderOnce())
  expect(t.captureCharFrame()).toContain("kept")
  expect(destroyed).not.toHaveBeenCalled()
  // Esc after a count only drops the count
  act(() => t.mockInput.pressKey("5"))
  await escape()
  expect(destroyed).not.toHaveBeenCalled()
  await escape()
  expect(destroyed).toHaveBeenCalled()
  destroyed.mockRestore()
})

test("a click or h/l picks the pane j/k move in, Esc goes back, and K/J move the other", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 100, height: 22 })
  destroy = () => act(() => t.renderer.destroy())
  const entry = (title: string, updatedMs: number): Entry => ({
    thread: { sessionId: title, profile: "claude-p", transcript: "/missing" } as Entry["thread"],
    agent: "claude",
    title,
    cwd: "/",
    updatedMs,
    live: null,
  })
  const keymap = createDefaultOpenTuiKeymap(t.renderer)
  act(() =>
    createRoot(t.renderer).render(
      <KeymapProvider keymap={keymap}>
        <Browser
          initial={[entry("first", Date.now()), entry("second", Date.now() - 1000)]}
          load={async () => []}
          watch={async () => ({ merge: (es) => es, scouting: false })}
          live={false}
          preview={true}
          recentMs={RECENT_MS}
          jump={async () => {}}
          onOpen={() => {}}
        />
      </KeymapProvider>,
    ),
  )
  const press = async (key: string, shift = false) => {
    act(() => t.mockInput.pressKey(key, { shift }))
    await act(() => t.renderOnce())
  }
  const click = async (x: number) => {
    await act(() => t.mockMouse.click(x, 10))
    await act(() => t.renderOnce())
  }
  await act(() => t.renderOnce())

  await click(70)
  await press("j")
  expect(t.captureCharFrame()).toMatch(/▌.*first/)
  await act(async () => {
    t.mockInput.pressEscape()
    await Bun.sleep(50)
  })
  await press("j")
  expect(t.captureCharFrame()).toMatch(/▌.*second/)

  await click(70)
  await press("k")
  expect(t.captureCharFrame()).toMatch(/▌.*second/)
  await click(10)
  await press("k")
  expect(t.captureCharFrame()).toMatch(/▌.*first/)

  // l and h do the same from the keyboard, and K/J move the other pane
  await press("l")
  await press("j")
  expect(t.captureCharFrame()).toMatch(/▌.*first/)
  await press("j", true)
  expect(t.captureCharFrame()).toMatch(/▌.*second/)
  await press("h")
  await press("k", true)
  expect(t.captureCharFrame()).toMatch(/▌.*second/)
  await press("k")
  expect(t.captureCharFrame()).toMatch(/▌.*first/)
})
