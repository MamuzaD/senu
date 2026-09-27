import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("today scan excludes copied fork usage, deduplicates events, and resumes appended files", () => {
  const dir = mkdtempSync(join(tmpdir(), "senu-today-"))
  const home = join(dir, "profile")
  const sessions = join(home, "sessions")
  mkdirSync(sessions, { recursive: true })
  const at = new Date()
  at.setHours(12, 0, 0, 0)
  const started = at.getTime()
  const event = (type: string, payload: object, after: number) =>
    JSON.stringify({ type, payload, timestamp: new Date(started + after).toISOString() }) + "\n"
  const usage = (input: number, cached: number, output: number) => ({
    type: "token_count",
    info: {
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
    },
  })
  const parent = join(sessions, "parent.jsonl")
  const child = join(sessions, "child.jsonl")
  writeFileSync(
    parent,
    event("session_meta", { id: "parent" }, 0) +
      event("turn_context", { model: "gpt-test" }, 10) +
      event("event_msg", usage(10, 2, 3), 100) +
      event("event_msg", usage(10, 2, 3), 200) +
      event("event_msg", usage(20, 5, 4), 2000),
  )
  writeFileSync(
    child,
    event("session_meta", { id: "child", forked_from_id: "parent" }, 3000) +
      event("turn_context", { model: "gpt-test" }, 3010) +
      event("event_msg", usage(10, 2, 3), 3100) +
      event("event_msg", usage(6, 0, 2), 3200) +
      event("event_msg", usage(7, 0, 1), 5000) +
      event("noise", { text: "x".repeat(256) }, 5500),
  )

  const script = `
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
    import { scanToday } from "./src/usage/today.ts"
    globalThis.fetch = async () => new Response(JSON.stringify({ "gpt-test": {
      input_cost_per_token: 0.000001, output_cost_per_token: 0.000002,
    } }))
    const profile = { kind: "codex", name: "fixture", home: process.env.FIXTURE_HOME }
    const at = new Date(process.env.FIXTURE_AT)
    const first = await scanToday(profile, at)
    const prior = readFileSync(process.env.FIXTURE_CHILD, "utf8")
    writeFileSync(process.env.FIXTURE_CHILD, prior.replace('"input_tokens":7', '"input_tokens":8'))
    appendFileSync(process.env.FIXTURE_CHILD, process.env.FIXTURE_APPEND)
    const second = await scanToday(profile, at)
    console.log(JSON.stringify({ first: first.tokens, second: second.tokens }))
  `
  try {
    const run = Bun.spawnSync([process.execPath, "-e", script], {
      env: {
        ...process.env,
        // bun test runs in UTC without setting TZ; the child must agree on "today".
        TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
        XDG_CACHE_HOME: join(dir, "cache"),
        FIXTURE_HOME: home,
        FIXTURE_AT: at.toISOString(),
        FIXTURE_CHILD: child,
        FIXTURE_APPEND: event("event_msg", usage(9, 0, 1), 6000),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout.toString())).toEqual({ first: 45, second: 55 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
