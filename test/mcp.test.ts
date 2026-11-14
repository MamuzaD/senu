import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer as netServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createServer } from "~/mcp/command.ts"
import { codexConfig, installCommand } from "~/mcp/install.ts"
import {
  agentLocation,
  deliverClaude,
  deliverCodex,
  messageText,
  sender,
  sendLimiter,
} from "~/mcp/send.ts"
import { MessageStore } from "~/mcp/store.ts"
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

test("agent locations use tmux pane indexes and Rex window positions", () => {
  const live = {
    state: "idle" as const,
    paneId: "%17",
    windowId: "@2",
    windowIndex: 2,
    session: "senu",
  }
  expect(agentLocation({ ...live, paneIndex: 0 })).toBe("senu:2.0")
  expect(agentLocation({ ...live, paneIndex: 3 })).toBe("senu:2.3")
  expect(agentLocation(live)).toBe("senu:2")
})

test("message attribution and process-local send rate limit", () => {
  const from = {
    agent: "codex",
    profile: "codex-work",
    sessionId: "id",
    title: "fix pagination",
    cwd: "/api",
  } as Thread
  const text = messageText(from, "Does /users paginate?", "question-id")
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
    expect(client.getInstructions()).toContain("reply_to set to its Message ID")
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "search_threads",
      "read_thread",
      "list_agents",
      "send_message",
      "wait_for_reply",
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
  rollout(config, 0, "other-session", [record("needle from CLI")])
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
  const db = new Database(join(config.profiles[0]!.home, "state_5.sqlite"))
  db.exec(`
    CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, name TEXT, title TEXT,
      updated_at_ms INTEGER, updated_at INTEGER, archived INTEGER, thread_source TEXT);
    INSERT INTO threads VALUES ('cli-session', '', '/fixture', NULL, 'needle from title', 1, 1, 0, 'user');
  `)
  db.close()
  const store = new MessageStore(join(root, "senu", "messages.sqlite"))
  let messageId: string
  try {
    const question = await store.send(
      "codex-personal:cli-session",
      "claude-work:peer",
      "question",
      undefined,
      async () => "delivered",
    )
    messageId = question.message_id
    await store.send(
      "claude-work:peer",
      "codex-personal:cli-session",
      "stored answer",
      messageId,
      async () => "delivered",
    )
  } finally {
    store.close()
  }
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH!,
    XDG_CONFIG_HOME: root,
    XDG_STATE_HOME: root,
    CODEX_THREAD_ID: "cli-session",
    ...env,
  }
  const cli = join(import.meta.dir, "..", "src", "cli.ts")
  const run = Bun.spawnSync([process.execPath, cli, "search", "needle"], {
    cwd: tmpdir(),
    env: { ...childEnv, CODEX_THREAD_ID: "" },
  })
  expect(run.exitCode).toBe(0)
  expect(JSON.parse(run.stdout.toString()).hits[0].excerpt).toBe("needle from CLI")
  const locks = join(config.profiles[0]!.home, "thread-writer-locks")
  mkdirSync(locks)
  const lock = openSync(join(locks, "cli-session.lock"), "w")
  const client = new Client({ name: "stdio-test", version: "1" })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp"],
      cwd: tmpdir(),
      env: { ...childEnv, CODEX_THREAD_ID: "" },
      stderr: "pipe",
    }),
  )
  try {
    const waited = await client.callTool({
      name: "wait_for_reply",
      arguments: { message_id: messageId!, timeout_ms: 1 },
    })
    expect(waited.isError).toBeFalsy()
    expect(JSON.parse((waited.content as { text: string }[])[0]!.text)).toMatchObject({
      timed_out: false,
      reply: { text: "stored answer" },
    })
    const path = join(root, "senu", "messages.sqlite")
    const peer = new MessageStore(path)
    const waits = new Database(path, { readonly: true })
    try {
      const asked = await peer.send(
        "codex-personal:cli-session",
        "claude-work:peer",
        "second question",
        undefined,
        async () => "delivered",
      )
      const waiting = client.callTool({
        name: "wait_for_reply",
        arguments: { message_id: asked.message_id, timeout_ms: 10_000 },
      })
      while (!waits.query("SELECT 1 FROM waits WHERE message_id = ?").get(asked.message_id))
        await Bun.sleep(10)
      let delivered = false
      const held = await peer.send(
        "claude-work:peer",
        "codex-personal:cli-session",
        "awaited answer",
        asked.message_id,
        async () => {
          delivered = true
          return "delivered"
        },
      )
      expect(held.delivery).toBe("returned to the waiting sender")
      expect(delivered).toBe(false)
      expect(JSON.parse(((await waiting).content as { text: string }[])[0]!.text)).toMatchObject({
        timed_out: false,
        reply: { text: "awaited answer" },
      })
    } finally {
      waits.close()
      peer.close()
    }
    const missing = await client.callTool({
      name: "wait_for_reply",
      arguments: { message_id: crypto.randomUUID(), timeout_ms: 1 },
    })
    expect(missing.isError).toBe(true)
    const result = await client.callTool({ name: "search_threads", arguments: { query: "needle" } })
    const content = result.content as { text: string }[]
    const hits = JSON.parse(content[0]!.text).hits
    expect(hits.map((hit: { session: string }) => hit.session)).toEqual(["other-session"])
    expect(hits[0].excerpt).toBe("needle from CLI")
    const excluded = await client.callTool({
      name: "search_threads",
      arguments: { query: "needle", excludeSession: ["other-session"] },
    })
    expect(JSON.parse((excluded.content as { text: string }[])[0]!.text).hits).toEqual([])
    const titles = await client.callTool({
      name: "search_threads",
      arguments: { query: "needle", only: "threads" },
    })
    expect(JSON.parse((titles.content as { text: string }[])[0]!.text).hits).toEqual([])
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
    closeSync(lock)
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

test("mcp install rewrites only senu's Codex tables and skips missing profiles", async () => {
  const { config } = setup()
  const path = join(config.profiles[0]!.home, "config.toml")
  writeFileSync(
    path,
    [
      'model = "x"',
      "",
      "[mcp_servers.senu]",
      'command = "/old/senu"',
      "",
      "[mcp_servers.senu.env]",
      'CODEX_HOME = "/old"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n"),
  )
  rmSync(config.profiles[1]!.home, { recursive: true })
  config.profiles.pop()
  const binaries = { claude: null, codex: "/bin/codex" }
  expect(await installCommand(config, ["/new/senu"], binaries)).toBe(0)
  const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as {
    model: string
    mcp_servers: Record<string, unknown>
  }
  expect(parsed.model).toBe("x")
  expect(parsed.mcp_servers).toEqual({
    other: { command: "other" },
    senu: {
      command: "/new/senu",
      args: ["mcp"],
      env_vars: ["REX_SESSION", "REX_BIN_DIR"],
      env: { CODEX_HOME: config.profiles[0]!.home },
    },
  })
  expect(codexConfig("", ["bun", "/src/cli.ts"], "/h")).toContain('args = ["/src/cli.ts","mcp"]')
  for (const earlier of [
    '[mcp_servers]\nsenu = { command = "/old" }\nother = { command = "other" }\n',
    '[mcp_servers."senu"]\ncommand = "/old"\n\n[mcp_servers."senu".env]\nCODEX_HOME = "/old"\n',
    'mcp_servers.senu.command = "/old"\nmodel = "x"\n',
    '[mcp_servers.senu]\ncommand = "/old"\n\n  [mcp_servers.other]\n  command = "other"\n',
  ]) {
    const servers = (
      Bun.TOML.parse(codexConfig(earlier, ["/new/senu"], "/h")) as {
        mcp_servers: Record<string, { command: string }>
      }
    ).mcp_servers
    expect(servers.senu!.command).toBe("/new/senu")
    expect(Object.keys(servers).filter((name) => name !== "other")).toEqual(["senu"])
  }
  expect(() =>
    codexConfig('mcp_servers = { senu = { command = "/old" } }\n', ["/s"], "/h"),
  ).toThrow("remove it and retry")
  expect(() =>
    codexConfig('notes = """\nmcp_servers.senu.command = "/old"\n"""\n', ["/s"], "/h"),
  ).toThrow("remove it and retry")
  const before = readFileSync(path, "utf8")
  expect(await installCommand(config, ["/newer/senu"], { claude: null, codex: null })).toBe(0)
  expect(readFileSync(path, "utf8")).toBe(before)
})
