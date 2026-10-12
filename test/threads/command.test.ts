import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { entryJson } from "~/threads/command.ts"
import { agentEntry, joinEntries, mergeLoaded, refreshLive, type Entry } from "~/threads/entries.ts"
import { launchFor } from "~/threads/resume.ts"
import type { Thread } from "~/threads/thread.ts"

describe("launchFor", () => {
  test("points codex at the thread's home, always", () => {
    expect(
      launchFor({ agent: "codex", sessionId: "s", cwd: "/p", home: join(homedir(), ".codex") }),
    ).toEqual({
      argv: ["codex", "resume", "s"],
      cwd: "/p",
      env: { CODEX_HOME: join(homedir(), ".codex") },
    })
  })

  test("sets CLAUDE_CONFIG_DIR only away from ~/.claude", () => {
    const at = (home: string) => launchFor({ agent: "claude", sessionId: "s", cwd: "/p", home })
    expect(at(join(homedir(), ".claude"))).toEqual({
      argv: ["claude", "--resume", "s"],
      cwd: "/p",
      env: {},
    })
    expect(at("/ai/.claude-work").env).toEqual({ CLAUDE_CONFIG_DIR: "/ai/.claude-work" })
  })
})

test("a running agent with no thread yet keeps its label, pane cwd, and activity", () => {
  const row = {
    windowId: "@2",
    session: "s",
    windowIndex: 1,
    windowName: "codex",
    paneId: "%3",
    agent: "codex" as const,
    state: "idle" as const,
    activity: 5,
    label: "codex",
    source: "live" as const,
  }
  expect(entryJson(agentEntry(row, "/p"))).toEqual({
    sessionId: null,
    agent: "codex",
    profile: null,
    title: "codex",
    cwd: "/p",
    updatedAt: "1970-01-01T00:00:05.000Z",
    live: { state: "idle", paneId: "%3", windowId: "@2", windowIndex: 1, session: "s" },
  })
})

describe("joinEntries", () => {
  const thread = (sessionId: string, updatedMs: number) => ({
    sessionId,
    agent: "claude" as const,
    profile: "claude-p",
    home: "/h",
    title: sessionId,
    cwd: "/p",
    updatedMs,
    transcript: "/t",
  })
  const row = (windowId: string, paneId: string, state: "working" | "idle", activity: number) => ({
    windowId,
    session: "s",
    windowIndex: 1,
    windowName: "w",
    paneId,
    agent: "codex" as const,
    state,
    activity,
    label: `label ${windowId}`,
    source: "watch" as const,
    active: false,
  })
  const panes = [
    { id: "%1", windowId: "@1", windowIndex: 1, session: "s", cwd: "/one" },
    { id: "%2", windowId: "@2", windowIndex: 1, session: "s", cwd: "/two" },
    { id: "%3", windowId: "@3", windowIndex: 1, session: "s", cwd: "/three" },
  ]
  const tmux = {
    panes,
    rows: [row("@1", "%1", "working", 50), row("@2", "%2", "idle", 40)],
    paneBySession: new Map([
      ["linked", "%1"],
      ["no-row", "%3"],
      ["unlisted", "%2"],
      ["pane-gone", "%9"],
    ]),
  }
  const threads = [
    thread("linked", 10),
    thread("no-row", 30),
    thread("past", 20),
    thread("pane-gone", 5),
  ]
  const summary = (withUnthreaded: boolean) =>
    joinEntries(threads, tmux, withUnthreaded).map((e) => [
      e.thread?.sessionId ?? e.title,
      e.live?.state ?? null,
      e.live?.paneId ?? null,
    ])

  test("marks running threads with their pane's state and keeps agents with no thread, newest first", () => {
    expect(summary(true)).toEqual([
      ["label @2", "idle", "%2"],
      ["no-row", "idle", "%3"],
      ["past", null, null],
      ["linked", "working", "%1"],
      ["pane-gone", null, null],
    ])
  })

  test("leaves agents with no thread out when asked", () => {
    expect(summary(false).map(([id]) => id)).toEqual(["no-row", "past", "linked", "pane-gone"])
  })

  test("an agent with no thread takes its pane's cwd and window activity", () => {
    const [unthreaded] = joinEntries(threads, tmux, true)
    expect(unthreaded).toMatchObject({ thread: null, cwd: "/two", updatedMs: 40_000 })
  })

  test("a thread sharing its window with another agent keeps its own pane's state", () => {
    const blocked = { ...row("@1", "%9", "idle", 60), state: "blocked" as const, label: "claude" }
    const split = {
      panes: [...panes, { id: "%9", windowId: "@1", windowIndex: 1, session: "s", cwd: "/one" }],
      rows: [blocked, row("@1", "%1", "idle", 50)],
      paneBySession: new Map([["linked", "%1"]]),
    }
    expect(
      joinEntries([thread("linked", 10)], split, true).map((e) => [e.title, e.live?.state]),
    ).toEqual([
      ["claude", "blocked"],
      ["linked", "idle"],
    ])
  })
})

describe("refreshLive", () => {
  const row = (windowId: string, state: "idle" | "working", label = windowId) => ({
    windowId,
    session: "s",
    windowIndex: 1,
    windowName: label,
    paneId: `%${windowId}`,
    agent: "codex" as const,
    state,
    activity: 5,
    label,
    source: "watch" as const,
    active: false,
  })
  const saved = {
    ...agentEntry(row("@1", "idle"), "/p"),
    thread: { sessionId: "t" } as Thread,
    title: "saved",
  }
  const loose = agentEntry(row("@2", "idle"), "/q")
  const seen = (rows: ReturnType<typeof row>[]) => ({
    rows,
    panes: rows.map((r) => ({ id: r.paneId, cwd: "/p" })),
  })

  test("takes each window's new state, and drops agents that are gone", () => {
    const got = refreshLive([saved, loose], seen([row("@1", "working")]), true)
    expect(got.map((e) => [e.title, e.live?.state ?? null])).toEqual([["saved", "working"]])
  })

  test("keeps a thread after its agent exits", () => {
    expect(refreshLive([saved], seen([]), true)).toMatchObject([{ title: "saved", live: null }])
  })

  test("adds agents it hasn't seen only when listing ones with no thread", () => {
    const fresh = [row("@1", "idle"), row("@3", "working", "new")]
    expect(refreshLive([saved], seen(fresh), true).map((e) => e.title)).toEqual(["saved", "new"])
    expect(refreshLive([saved], seen(fresh), false).map((e) => e.title)).toEqual(["saved"])
  })

  test("a surviving agent in the window does not keep an exited thread's pane live", () => {
    const replacement = { ...row("@1", "working", "replacement"), paneId: "%new" }
    const got = refreshLive([saved], seen([replacement]), true)
    expect(got.find((e) => e.thread)?.live).toBeNull()
    expect(got.find((e) => !e.thread)).toMatchObject({
      title: "replacement",
      cwd: "/p",
      live: { paneId: "%new" },
    })
  })

  test("a thread follows its pane to another window", () => {
    const moved = { ...row("@1", "working"), windowId: "@5", windowIndex: 3, session: "t" }
    expect(refreshLive([saved], seen([moved]), true)).toMatchObject([
      {
        title: "saved",
        live: { paneId: "%@1", windowId: "@5", windowIndex: 3, session: "t", state: "working" },
      },
    ])
  })

  test("a thread sharing its window keeps its own pane's state, next to the other agent", () => {
    const other = { ...row("@1", "working", "other"), paneId: "%other" }
    const got = refreshLive([saved], seen([other, row("@1", "idle")]), true)
    expect(got.map((e) => [e.title, e.live?.paneId, e.live?.state])).toEqual([
      ["saved", "%@1", "idle"],
      ["other", "%other", "working"],
    ])
  })
})

test("mergeLoaded keeps the threads a narrower load skipped, stopped if they were running", () => {
  const live = {
    state: "idle" as const,
    paneId: "%1",
    windowId: "@1",
    windowIndex: 1,
    session: "s",
  }
  const entry = (id: string | null, title: string, updatedMs: number, running = false): Entry => ({
    thread: id ? ({ sessionId: id } as Thread) : null,
    agent: "codex",
    title,
    cwd: "/p",
    updatedMs,
    live: running ? live : null,
  })
  const last = [
    entry("a", "renamed later", 4, true),
    entry("b", "stopped since", 3, true),
    entry(null, "agent with no thread", 2, true),
    entry("c", "older", 1),
  ]
  const got = mergeLoaded(last, [entry("a", "renamed", 5, true)])
  expect(got.map((e) => [e.title, !!e.live])).toEqual([
    ["renamed", true],
    ["stopped since", false],
    ["older", false],
  ])
  // Past the cutoff the load read everything, so a thread it missed was archived or deleted
  expect(mergeLoaded(last, [], 2).map((e) => e.title)).toEqual(["older"])
})

describe("senu threads", () => {
  const dir = mkdtempSync(join(tmpdir(), "senu-threads-cli-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const claude = join(dir, "claude")
  mkdirSync(join(claude, "projects", "-p"), { recursive: true })
  for (const [id, title, at] of [
    ["old", "older one", 1],
    ["new", "newer one", 2],
  ] as const) {
    const path = join(claude, "projects", "-p", `${id}.jsonl`)
    writeFileSync(path, JSON.stringify({ type: "ai-title", aiTitle: title, cwd: "/p" }) + "\n")
    utimesSync(path, at, at)
  }
  mkdirSync(join(dir, "config", "senu"), { recursive: true })
  writeFileSync(
    join(dir, "config", "senu", "config.toml"),
    `[[profiles]]\nkind = "claude"\nname = "test"\nhome = "${claude}"\n`,
  )

  const cli = join(import.meta.dir, "..", "..", "src", "cli.ts")
  const { TMUX: _, ...inherited } = process.env
  const env = { ...inherited, XDG_CONFIG_HOME: join(dir, "config"), TMUX_TMPDIR: dir }
  const senu = (...args: string[]) => {
    const run = Bun.spawnSync([process.execPath, cli, "threads", ...args], { env, cwd: dir })
    return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
  }

  test("--json lists newest first, none live without tmux", () => {
    const { code, out } = senu("--json", "--limit", "1")
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual([
      {
        sessionId: "new",
        agent: "claude",
        profile: "claude-test",
        title: "newer one",
        cwd: "/p",
        updatedAt: "1970-01-01T00:00:02.000Z",
        live: null,
      },
    ])
  })

  test("--live without tmux has nothing running", () => {
    expect(senu("--live").out).toBe("no running agents\n")
  })

  test("names the profiles there are when one is unknown", () => {
    expect(senu("--profile", "codex-x")).toMatchObject({
      code: 2,
      err: "senu threads: no profile codex-x (have claude-test)\n",
    })
  })

  test("resume refuses a session it doesn't know, and a directory that's gone", () => {
    expect(senu("resume", "nope")).toMatchObject({ code: 1, err: "senu threads: no thread nope\n" })
    expect(senu("resume", "new")).toMatchObject({
      code: 1,
      err: "senu threads: /p no longer exists\n",
    })
  })
})
