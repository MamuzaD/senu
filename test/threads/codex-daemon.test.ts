import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { codexThreadIdentities } from "~/threads/codex.ts"
import { addCodexTitles } from "~/threads/running.ts"

const thread = { key: "codex-work:a", cwd: "/work", titles: ["Review frontend"] }
const pane = { id: "%1", cwd: "/work", oscTitle: "⠧ Review frontend | work", session: "s" }

describe("daemon title matching", () => {
  test("matches either title and preserves process matches", () => {
    expect(addCodexTitles(new Map(), [thread], [pane])).toEqual(new Map([[thread.key, "%1"]]))
    const renamed = { ...thread, titles: ["Original prompt", "Review frontend"] }
    expect(addCodexTitles(new Map(), [renamed], [pane]).size).toBe(1)
    const live = new Map([[thread.key, "%2"]])
    expect(addCodexTitles(live, [thread], [pane])).toEqual(live)
    expect(addCodexTitles(new Map([["other", "%1"]]), [thread], [pane])).toEqual(
      new Map([["other", "%1"]]),
    )
  })

  test("rejects duplicate threads, profiles, panes, and directory mismatches", () => {
    for (const key of ["codex-work:b", "codex-personal:a"])
      expect(addCodexTitles(new Map(), [thread, { ...thread, key }], [pane]).size).toBe(0)
    expect(addCodexTitles(new Map(), [thread], [pane, { ...pane, id: "%2" }]).size).toBe(0)
    for (const change of [
      { cwd: "/other" },
      { oscTitle: "Action required | work" },
      { oscTitle: "work" },
      { oscTitle: "Review front… | work" },
    ])
      expect(addCodexTitles(new Map(), [thread], [{ ...pane, ...change }]).size).toBe(0)
  })

  test("detects collisions after Codex sanitizes the emitted title", () => {
    const clean = { ...thread, key: "codex-work:b", titles: ["Review frontend"] }
    for (const name of [
      "Review  frontend",
      "Review\nfrontend",
      "Review\tfrontend",
      "Review\u200b frontend",
    ]) {
      const dirty = { ...thread, titles: [name] }
      expect(addCodexTitles(new Map(), [dirty], [pane])).toEqual(new Map([[thread.key, "%1"]]))
      expect(addCodexTitles(new Map(), [dirty, clean], [pane]).size).toBe(0)
    }
  })

  test("preserves literal task prefixes and permits task names equal to the session", () => {
    for (const name of ["* Fix login", "• Fix login", "- Fix login"]) {
      const marked = { ...thread, titles: [name] }
      const unmarked = { ...thread, key: "codex-work:b", titles: ["Fix login"] }
      const shown = { ...pane, oscTitle: `⠧ ${name} | work` }
      expect(addCodexTitles(new Map(), [marked, unmarked], [shown])).toEqual(
        new Map([[thread.key, "%1"]]),
      )
    }
    expect(
      addCodexTitles(new Map(), [thread], [{ ...pane, session: "Review frontend" }]).size,
    ).toBe(1)
    // A task can start with a real spinner character too: do not guess its role.
    const spinnerName = { ...thread, titles: ["⠧ Review frontend"] }
    expect(addCodexTitles(new Map(), [thread, spinnerName], [pane]).size).toBe(0)
  })

  test("rejects ambiguous boundaries when project names contain separators", () => {
    const a = { key: "codex-work:a", cwd: "/work/frontend | work", titles: ["Review"] }
    const b = { ...a, key: "codex-work:b", titles: ["Review | frontend"] }
    const shown = { ...pane, cwd: a.cwd, oscTitle: "⠧ Review | frontend | work" }
    expect(addCodexTitles(new Map(), [a], [shown])).toEqual(new Map([[a.key, "%1"]]))
    expect(addCodexTitles(new Map(), [a, b], [shown]).size).toBe(0)
  })

  test("does not mistake action-required status for a thread name", () => {
    for (const status of ["[ ! ] Action Required", "[ . ] Action Required", "Action required"]) {
      for (const microphone of ["", "● "]) {
        const namedLikeStatus = { ...thread, key: "codex-work:b", titles: [status] }
        const shown = { ...pane, oscTitle: `${microphone}${status} | Review frontend | work` }
        expect(addCodexTitles(new Map(), [thread, namedLikeStatus], [shown]).size).toBe(0)
      }
    }
  })

  test("truncates before collapsing whitespace or removing invisibles", () => {
    const raw = "a".repeat(43) + "  tail beyond limit"
    const shown = { ...pane, oscTitle: `⠧ ${"a".repeat(43)} ... | work` }
    const long = { ...thread, titles: [raw] }
    expect(addCodexTitles(new Map(), [long], [shown]).size).toBe(1)
    const wronglyNormalizedFirst = { ...pane, oscTitle: `⠧ ${"a".repeat(43)} t... | work` }
    expect(addCodexTitles(new Map(), [long], [wronglyNormalizedFirst]).size).toBe(0)
  })

  test("matches Codex's exact 48-grapheme truncation and rejects collisions", () => {
    const prefix = "👨‍👩‍👧‍👦".repeat(45)
    const long = { ...thread, titles: [prefix + "long tail"] }
    const truncated = { ...pane, oscTitle: `⠧ ${"👨👩👧👦".repeat(45)}... | work` }
    expect(addCodexTitles(new Map(), [long], [truncated]).size).toBe(1)
    expect(
      addCodexTitles(
        new Map(),
        [long, { ...long, key: "codex-work:b", titles: [prefix + "other tail"] }],
        [truncated],
      ).size,
    ).toBe(0)
  })
})

test("runningThreads resolves daemon clients through the full discovery path", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "senu-daemon-")))
  // Actual argv distinguishes the server from clients. ps/lsof fixtures model their topology.
  const sleeper = "setInterval(() => {}, 1000)"
  const server = Bun.spawn([process.execPath, "-e", sleeper, "app-server", "--managed-daemon"], {
    stdout: "ignore",
    stderr: "pipe",
  })
  const client = Bun.spawn([process.execPath, "-e", sleeper], { stdout: "ignore", stderr: "pipe" })
  const client2 = Bun.spawn([process.execPath, "-e", sleeper], { stdout: "ignore", stderr: "pipe" })
  try {
    const home = join(dir, "codex")
    mkdirSync(join(home, "thread-writer-locks"), { recursive: true })
    for (const id of ["a", "b", "sub", "archived"])
      writeFileSync(join(home, "thread-writer-locks", id + ".lock"), "")
    const db = new Database(join(home, "state_5.sqlite"))
    db.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, name TEXT, title TEXT, updated_at_ms INTEGER, updated_at INTEGER, archived INTEGER, thread_source TEXT);
      INSERT INTO threads VALUES ('a', '', '/work', 'Review frontend', 'Original\nprompt', 1, 1, 0, 'user'),
      ('b', '', '/work', NULL, 'Other task', 1, 1, 0, 'user'),
      ('sub', '', '/work', NULL, 'Review frontend', 1, 1, 0, 'subagent'),
      ('archived', '', '/work', NULL, 'Review frontend', 1, 1, 1, 'user');`)
    db.close()
    const profile = { kind: "codex" as const, name: "work", home }
    expect(
      codexThreadIdentities(
        profile,
        new Set(["codex-work:a", "codex-work:sub", "codex-work:archived", "codex-other:b"]),
      ),
    ).toEqual([{ key: thread.key, cwd: "/work", titles: ["Original\nprompt", "Review frontend"] }])
    const locks = ["a", "b", "sub", "archived"]
      .map((id) => "n" + join(home, "thread-writer-locks", id + ".lock"))
      .join("\n")
    for (const [name, text] of Object.entries({
      ps: `${server.pid} ${client.pid} codex\n${client.pid} 100 codex\n${client2.pid} 200 codex\n100 1 zsh\n200 1 zsh\n`,
      lsof: `p${server.pid}\n${locks}\n`,
    })) {
      const path = join(dir, name)
      writeFileSync(path, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(text)})\n`)
      chmodSync(path, 0o755)
    }
    const source = join(import.meta.dir, "../../src/threads/running.ts")
    const probe = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { runningThreads } from ${JSON.stringify(source)};
      const profile = ${JSON.stringify(profile)};
      const pane = ${JSON.stringify({ ...pane, pid: 100, dead: false })};
      const result = await runningThreads([profile], [pane]);
      console.log(JSON.stringify({ live: [...result.paneByThread], off: [...result.offPane.keys()] }));
      const ambiguous = await runningThreads([profile], [pane, { ...pane, id: "%2", pid: 200 }]);
      console.log(JSON.stringify({ live: [...ambiguous.paneByThread] }));
      const two = await runningThreads([profile], [pane, { ...pane, id: "%2", pid: 200, oscTitle: "Other task | work" }]);
      console.log(JSON.stringify({ live: [...two.paneByThread] }));
    `,
      ],
      {
        env: { ...process.env, PATH: dir + ":" + process.env.PATH },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const out = await new Response(probe.stdout).text()
    const err = await new Response(probe.stderr).text()
    expect(await probe.exited, err).toBe(0)
    const [matched, ambiguous, two] = out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(matched.live).toEqual([["codex-work:a", "%1"]])
    expect(matched.off).toContain("codex-work:b")
    expect(ambiguous.live).toEqual([])
    expect(two.live).toEqual([
      ["codex-work:a", "%1"],
      ["codex-work:b", "%2"],
    ])
  } finally {
    server.kill()
    client.kill()
    client2.kill()
    await Promise.all([server.exited, client.exited, client2.exited])
    rmSync(dir, { recursive: true, force: true })
  }
})
