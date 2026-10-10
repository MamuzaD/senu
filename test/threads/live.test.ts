import { describe, expect, test } from "bun:test"

import { panesFor, parseLsof, parseProcs, stillClaude } from "~/threads/live.ts"

describe("parseLsof", () => {
  test("groups the locks each process holds", () => {
    const out = [
      "p35958",
      "f27",
      "n/h/.codex/thread-writer-locks/a.lock",
      "f37",
      "n/h/.codex/thread-writer-locks/b.lock",
      "p71140",
      "f12",
      "n/h/.codex-work/thread-writer-locks/c.lock",
      "",
    ].join("\n")
    expect(parseLsof(out)).toEqual(
      new Map([
        [35958, ["a", "b"]],
        [71140, ["c"]],
      ]),
    )
  })

  test("adds to holders it's given", () => {
    expect(parseLsof("p2\nn/x/b.lock\n", new Map([[1, ["a"]]]))).toEqual(
      new Map([
        [1, ["a"]],
        [2, ["b"]],
      ]),
    )
  })
})

test("parseProcs reads ps's padded columns, commands with spaces included", () => {
  expect(parseProcs("    1     0 launchd\n  412     1 /Applications/My App/bin/x\nbad\n")).toEqual(
    new Map([
      [1, { ppid: 0, command: "launchd" }],
      [412, { ppid: 1, command: "/Applications/My App/bin/x" }],
    ]),
  )
})

describe("stillClaude", () => {
  const procs = new Map([
    [10, { ppid: 1, command: "claude" }],
    [11, { ppid: 1, command: "node" }],
    [12, { ppid: 1, command: "zsh" }],
  ])
  const argv = (pid: number) => (pid === 11 ? ["node", "/usr/local/bin/claude"] : [])

  test("keeps session files whose pid still runs claude, natively or under node", () => {
    const claude = new Map([
      [10, ["native"]],
      [11, ["npm"]],
    ])
    expect(stillClaude(claude, procs, argv)).toEqual(claude)
  })

  test("drops session files left by a crash, gone or reused by another process", () => {
    const claude = new Map([
      [12, ["reused-pid"]],
      [99, ["exited"]],
    ])
    expect(stillClaude(claude, procs, argv)).toEqual(new Map())
  })
})

describe("panesFor", () => {
  // shell 100 (%1) → node 101 → codex 102; shell 200 (%2) runs claude 200 directly
  const procs = new Map(
    [
      [102, 101],
      [101, 100],
      [100, 1],
      [300, 1],
    ].map(([pid, ppid]) => [pid!, { ppid: ppid!, command: "x" }]),
  )
  const panes = [
    { id: "%1", pid: 100 },
    { id: "%2", pid: 200 },
  ]

  test("walks each holder up to its pane", () => {
    const holders = new Map([
      [102, ["codex-thread", "its-subagent"]],
      [200, ["claude-session"]],
    ])
    expect(panesFor(holders, procs, panes)).toEqual(
      new Map([
        ["codex-thread", "%1"],
        ["its-subagent", "%1"],
        ["claude-session", "%2"],
      ]),
    )
  })

  test("leaves out sessions outside tmux and processes that exited", () => {
    const holders = new Map([
      [300, ["in-a-plain-terminal"]],
      [999, ["stale-session-file"]],
    ])
    expect(panesFor(holders, procs, panes)).toEqual(new Map())
  })
})
