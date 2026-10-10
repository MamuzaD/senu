import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { agentEntry, entryJson, joinEntries } from "~/threads/command.ts"
import { launchFor } from "~/threads/resume.ts"

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
    live: { state: "idle", paneId: "%3", windowId: "@2", session: "s" },
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
  })
  const panes = [
    { id: "%1", windowId: "@1", session: "s", cwd: "/one" },
    { id: "%2", windowId: "@2", session: "s", cwd: "/two" },
    { id: "%3", windowId: "@3", session: "s", cwd: "/three" },
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

  test("marks running threads with their window's state and keeps agents with no thread, newest first", () => {
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
    `[[usage.profiles]]\nkind = "claude"\nname = "test"\nhome = "${claude}"\n`,
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
