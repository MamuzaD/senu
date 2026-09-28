import { describe, expect, test } from "bun:test"

import type { AgentState } from "~/detect/manifest.ts"
import {
  fold,
  IDLE_CAP_MS,
  IDLE_RECHECK_MS,
  isPending,
  newPaneTrack,
  observe,
  shouldPlay,
  step,
  type PaneState,
  type PaneTrack,
  type WindowTrack,
} from "~/watch/state.ts"

const det = (
  state: AgentState,
  extra: { visibleIdle?: boolean; skipStateUpdate?: boolean } = {},
) => ({
  state,
  visibleIdle: false,
  skipStateUpdate: false,
  ...extra,
})

const working = (): PaneTrack => {
  const t = newPaneTrack()
  observe(t, det("working"), 0)
  return t
}

describe("observe: herdr's idle hold", () => {
  test("the first read publishes at once", () => {
    const t = newPaneTrack()
    expect(observe(t, det("idle"), 0)).toBe(true)
    expect(t.state).toBe("idle")
  })

  test("working → plain idle waits for three more idle reads", () => {
    const t = working()
    const r = IDLE_RECHECK_MS
    expect(observe(t, det("idle"), 1000)).toBe(false)
    expect(isPending(t)).toBe(true)
    expect(observe(t, det("idle"), 1000 + r)).toBe(false)
    expect(observe(t, det("idle"), 1000 + 2 * r)).toBe(false)
    expect(t.state).toBe("working")
    expect(observe(t, det("idle"), 1000 + 3 * r)).toBe(true)
    expect(t.state).toBe("idle")
    expect(isPending(t)).toBe(false)
  })

  test("the hold gives up after 700 ms", () => {
    const t = working()
    observe(t, det("idle"), 1000)
    expect(observe(t, det("idle"), 1000 + IDLE_CAP_MS)).toBe(true)
  })

  test("a working read in between cancels the flip (a spinner flicker)", () => {
    const t = working()
    observe(t, det("idle"), 1000)
    observe(t, det("idle"), 1100)
    expect(observe(t, det("working"), 1200)).toBe(false)
    expect(isPending(t)).toBe(false)
    expect(observe(t, det("idle"), 1300)).toBe(false)
    expect(observe(t, det("idle"), 1400)).toBe(false)
    expect(observe(t, det("idle"), 1500)).toBe(false)
    expect(t.state).toBe("working")
  })

  test("visible idle skips the hold", () => {
    const t = working()
    expect(observe(t, det("idle", { visibleIdle: true }), 1000)).toBe(true)
  })

  test("working → blocked is never held", () => {
    const t = working()
    expect(observe(t, det("blocked"), 1000)).toBe(true)
  })

  test("codex unknown stays ambiguous until the idle hold finishes", () => {
    const t = working()
    expect(observe(t, det("unknown"), 1000)).toBe(false)
    for (const n of [1, 2]) observe(t, det("unknown"), 1000 + n * 100)
    expect(observe(t, det("unknown"), 1300)).toBe(true)
    expect(t.state).toBe("unknown")
    expect(fold([t.state])).toBe("idle")
  })

  test("skip_state_update changes nothing and cancels a pending flip", () => {
    const t = working()
    observe(t, det("idle"), 1000)
    expect(observe(t, det("unknown", { skipStateUpdate: true }), 1100)).toBe(false)
    expect(t.state).toBe("working")
    expect(isPending(t)).toBe(false)
  })
})

describe("fold", () => {
  test("blocked > working > idle", () => {
    expect(fold(["idle", "working", "blocked"])).toBe("blocked")
    expect(fold(["idle", "working"])).toBe("working")
    expect(fold(["idle", null])).toBe("idle")
  })
  test("no settled pane, no state", () => expect(fold([null])).toBeNull())
})

describe("step: windows, done and sounds", () => {
  const w = (states: (PaneState | null)[], focused = false, id = "@1") => ({ id, states, focused })

  test("a window's first tick never chimes", () => {
    const windows = new Map<string, WindowTrack>()
    expect(step(windows, [w(["blocked"])]).sounds).toEqual([])
    expect(step(windows, [w(["blocked"])]).display.get("@1")).toBe("blocked")
  })

  test("a background finish shows done until you focus the window", () => {
    const windows = new Map<string, WindowTrack>()
    step(windows, [w(["working"])])
    const finished = step(windows, [w(["idle"])])
    expect(finished.display.get("@1")).toBe("done")
    expect(finished.sounds).toEqual([{ kind: "done", window: "@1", focused: false }])
    expect(step(windows, [w(["idle"])]).display.get("@1")).toBe("done")
    expect(step(windows, [w(["idle"], true)]).display.get("@1")).toBe("idle")
    expect(step(windows, [w(["idle"])]).display.get("@1")).toBe("idle")
  })

  test("a done left by the previous watcher survives until you focus the window", () => {
    const windows = new Map<string, WindowTrack>()
    const left = { ...w(["idle"]), shownDone: true }
    expect(step(windows, [left]).display.get("@1")).toBe("done")
    expect(step(windows, [w(["idle"])]).display.get("@1")).toBe("done")
    expect(step(windows, [w(["idle"], true)]).display.get("@1")).toBe("idle")
  })

  test("a left done survives a first tick with no settled pane", () => {
    const windows = new Map<string, WindowTrack>()
    const unsettled = { ...w([null]), shownDone: true }
    expect(step(windows, [unsettled]).display.get("@1")).toBe("done")
    expect(step(windows, [{ ...w(["idle"]), shownDone: true }]).display.get("@1")).toBe("done")
  })

  test("focusing a window with no settled pane clears a left done", () => {
    const windows = new Map<string, WindowTrack>()
    expect(step(windows, [{ ...w([null], true), shownDone: true }]).display.has("@1")).toBe(false)
  })

  test("a left done clears when the window is busy again", () => {
    const windows = new Map<string, WindowTrack>()
    expect(step(windows, [{ ...w(["working"]), shownDone: true }]).display.get("@1")).toBe(
      "working",
    )
  })

  test("a finish in front is plain idle, with a focused sound event", () => {
    const windows = new Map<string, WindowTrack>()
    step(windows, [w(["working"], true)])
    const s = step(windows, [w(["idle"], true)])
    expect(s.display.get("@1")).toBe("idle")
    expect(s.sounds).toEqual([{ kind: "done", window: "@1", focused: true }])
  })

  test("new work clears a pending done", () => {
    const windows = new Map<string, WindowTrack>()
    step(windows, [w(["working"])])
    step(windows, [w(["idle"])])
    expect(step(windows, [w(["working"])]).display.get("@1")).toBe("working")
    expect(step(windows, [w(["idle"], false)]).display.get("@1")).toBe("done")
  })

  test("entering blocked requests; staying blocked doesn't", () => {
    const windows = new Map<string, WindowTrack>()
    step(windows, [w(["working"])])
    expect(step(windows, [w(["blocked"])]).sounds.map((s) => s.kind)).toEqual(["request"])
    expect(step(windows, [w(["blocked"])]).sounds).toEqual([])
  })

  test("blocked → idle is you answering, not a finish", () => {
    const windows = new Map<string, WindowTrack>()
    step(windows, [w(["blocked"])])
    const s = step(windows, [w(["idle"])])
    expect(s.sounds).toEqual([])
    expect(s.display.get("@1")).toBe("idle")
  })

  test("the window folds its panes: one pane finishing while another works is not done", () => {
    const windows = new Map<string, WindowTrack>()
    step(windows, [w(["working", "working"])])
    expect(step(windows, [w(["idle", "working"])]).sounds).toEqual([])
  })

  test("a window without agents is dropped", () => {
    const windows = new Map<string, WindowTrack>()
    step(windows, [w(["working"]), w(["idle"], false, "@2")])
    const s = step(windows, [w(["idle"], false, "@2")])
    expect([...s.display.keys()]).toEqual(["@2"])
    expect(windows.has("@1")).toBe(false)
  })
})

describe("shouldPlay", () => {
  const bg = { kind: "done" as const, window: "@1", focused: false }
  const fg = { ...bg, focused: true }
  test("background windows chime", () =>
    expect(shouldPlay(bg, { enabled: true, always: false })).toBe(true))
  test("the focused window only with sound.always", () => {
    expect(shouldPlay(fg, { enabled: true, always: false })).toBe(false)
    expect(shouldPlay(fg, { enabled: true, always: true })).toBe(true)
  })
  test("sound.enabled off silences everything", () =>
    expect(shouldPlay(fg, { enabled: false, always: true })).toBe(false))
})
