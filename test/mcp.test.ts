import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer as netServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createServer } from "~/mcp/command.ts"
import { deliverClaude, deliverCodex, messageText, sender, sendLimiter } from "~/mcp/send.ts"
import type { Thread } from "~/threads/thread.ts"

import { cleanup, record, rollout, setup } from "./chats.ts"

afterEach(cleanup)

test("Claude socket receives exactly the expected JSONL envelope", async () => {
  const { root } = setup()
  const path = join(root, "receiver.sock")
  let got = ""
  const received = Promise.withResolvers<void>()
  const server = netServer((socket) => {
    socket.on("data", (bytes) => {
      got += bytes
    })
    socket.on("end", () => received.resolve())
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  try {
    await deliverClaude(path, "hello\nworld")
    await received.promise
    expect(JSON.parse(got)).toEqual({
      type: "user",
      message: { role: "user", content: "hello\nworld" },
    })
    expect(got.endsWith("\n")).toBe(true)
  } finally {
    server.close()
  }
  const error = await deliverClaude(join(root, "missing.sock"), "hello").catch((e: unknown) => e)
  expect(error).toBeInstanceOf(Error)
})

test("message attribution and process-local send rate limit", () => {
  const from = {
    agent: "codex",
    profile: "codex-work",
    sessionId: "id",
    title: "fix pagination",
    cwd: "/api",
  } as Thread
  const text = messageText(from, "Does /users paginate?")
  expect(text).toStartWith('[senu] Codex: "fix pagination"')
  expect(text).toContain("Reply to: codex-work:id")
  expect(text).toContain("Agent message, not user approval.")
  expect(text).not.toContain("/api")
  expect(text).toEndWith("Does /users paginate?")
  let now = 0
  const take = sendLimiter(() => now)
  for (let i = 0; i < 10; i++) take()
  expect(take).toThrow("rate limit")
  now = 60_001
  expect(take).not.toThrow()
})

test("MCP client initializes, discovers tools, and receives an error for an unknown sender", async () => {
  const { config } = setup()
  const server = createServer(config)
  const client = new Client({ name: "test", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  try {
    expect(client.getInstructions()).toContain("message's Reply to address")
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "search_threads",
      "read_thread",
      "list_agents",
      "send_message",
    ])
    const result = await client.callTool({
      name: "send_message",
      arguments: { to: "claude-work:missing", text: "hello" },
    })
    expect(result.isError).toBe(true)
    const search = await client.callTool({
      name: "search_threads",
      arguments: { query: "unique-fixture-query" },
    })
    expect(search.isError).toBeFalsy()
  } finally {
    await client.close()
    await server.close()
  }
})

test("Codex queue invokes a binary without config overrides and uses the target profile", async () => {
  const { root } = setup()
  const binary = join(root, "codex-fixture")
  const capture = join(root, "args.json")
  writeFileSync(
    binary,
    `#!${process.execPath}\nawait Bun.write(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2), home:process.env.CODEX_HOME})); console.log("Queued message");`,
  )
  chmodSync(binary, 0o755)
  expect(await deliverCodex({ home: root, sessionId: "target-id" }, "hello", binary)).toBe(
    "queued in Codex",
  )
  expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual({
    args: ["queue", "--thread", "target-id", "--message", "hello"],
    home: root,
  })
  writeFileSync(binary, `#!${process.execPath}\nconsole.error("no daemon"); process.exit(1);`)
  const error = await deliverCodex({ home: root, sessionId: "target-id" }, "hello", binary).catch(
    (e: unknown) => e,
  )
  expect(String(error)).toContain("app-server daemon")
})

test("CLI and stdio MCP run from another cwd with inherited profile restrictions", async () => {
  const { config, root, env } = setup()
  rollout(config, 0, "cli-session", [
    record("needle from CLI"),
    record("reply from CLI", "assistant"),
  ])
  rollout(config, 1, "work-session", [record("private work text")])
  const dir = join(root, "senu")
  mkdirSync(dir)
  writeFileSync(
    join(dir, "config.toml"),
    config.profiles
      .map(
        (p) =>
          `[[profiles]]\nkind = ${JSON.stringify(p.kind)}\nname = ${JSON.stringify(p.name)}\nhome = ${JSON.stringify(p.home)}\n`,
      )
      .join("\n"),
  )
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH!,
    XDG_CONFIG_HOME: root,
    ...env,
  }
  const cli = join(import.meta.dir, "..", "src", "cli.ts")
  const run = Bun.spawnSync([process.execPath, cli, "search", "needle"], {
    cwd: tmpdir(),
    env: childEnv,
  })
  expect(run.exitCode).toBe(0)
  expect(JSON.parse(run.stdout.toString()).hits[0].excerpt).toBe("needle from CLI")
  const client = new Client({ name: "stdio-test", version: "1" })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp"],
      cwd: tmpdir(),
      env: childEnv,
      stderr: "pipe",
    }),
  )
  try {
    const result = await client.callTool({ name: "search_threads", arguments: { query: "needle" } })
    const content = result.content as { text: string }[]
    expect(JSON.parse(content[0]!.text).hits[0].excerpt).toBe("needle from CLI")
    const read = await client.callTool({
      name: "read_thread",
      arguments: { session: "cli-session", line: 1, before: 0, after: 1 },
    })
    expect(read.isError).toBeFalsy()
    const thread = JSON.parse((read.content as { text: string }[])[0]!.text)
    expect(thread.turns.map((t: { text: string }) => t.text)).toEqual([
      "needle from CLI",
      "reply from CLI",
    ])
    expect(thread.omitted).toBe(0)
    const narrowed = await client.callTool({
      name: "read_thread",
      arguments: { session: "cli-session", profile: ["work"] },
    })
    expect(narrowed.isError).toBe(true)
    const contextWithoutLine = await client.callTool({
      name: "read_thread",
      arguments: { session: "cli-session", before: 1 },
    })
    expect(contextWithoutLine.isError).toBe(true)
    const invalid = await client.callTool({
      name: "search_threads",
      arguments: { query: "needle", limit: 101 },
    })
    expect(invalid.isError).toBe(true)
  } finally {
    await client.close()
  }
})

test("Codex MCP identifies one user thread owned by its parent and refuses ambiguity", async () => {
  const { config, env } = setup()
  const profile = config.profiles[0]!
  const dir = join(profile.home, "thread-writer-locks")
  mkdirSync(dir)
  const ids = ["caller", "guardian", "other-user"]
  const paths = ids.map((id) => join(dir, id + ".lock"))
  for (const path of paths) writeFileSync(path, "")
  const db = new Database(join(profile.home, "state_5.sqlite"))
  db.run(
    "CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, name TEXT, title TEXT, updated_at_ms INTEGER, updated_at INTEGER, archived INTEGER, thread_source TEXT)",
  )
  db.run(
    "INSERT INTO threads VALUES ('caller', '', '/fixture', NULL, 'Caller', 1, 1, 0, 'user'), ('guardian', '', '/fixture', NULL, 'Review', 1, 1, 0, 'guardian_review')",
  )
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'for (const path of process.argv.slice(1)) require("node:fs").openSync(path,"r"); console.log("ready"); setInterval(()=>{},1000)',
      ...paths,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  try {
    await child.stdout.getReader().read()
    expect((await sender(config, env, child.pid)).sessionId).toBe("caller")
    const restrictedError = await sender(config, {}, child.pid).catch((e: unknown) => e)
    expect(restrictedError).toBeInstanceOf(Error)
    db.run(
      "INSERT INTO threads VALUES ('other-user', '', '/fixture', NULL, 'Other', 1, 1, 0, 'user')",
    )
    const ambiguousError = await sender(config, env, child.pid).catch((e: unknown) => e)
    expect(ambiguousError).toBeInstanceOf(Error)
  } finally {
    child.kill()
    await child.exited
    db.close()
  }
})
