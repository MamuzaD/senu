import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

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
  const env = { ...inherited, XDG_CONFIG_HOME: join(dir, "config") }
  const senu = (...args: string[]) => {
    const run = Bun.spawnSync([process.execPath, cli, "threads", ...args], { env, cwd: dir })
    return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() }
  }

  test("--json lists newest first", () => {
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
      },
    ])
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
