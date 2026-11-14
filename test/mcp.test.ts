import { afterEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createServer } from "~/mcp/command.ts"

import { cleanup, record, rollout, setup } from "./chats.ts"

afterEach(cleanup)

test("MCP client initializes, discovers tools, and searches", async () => {
  const { config } = setup()
  const server = createServer(config)
  const client = new Client({ name: "test", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  await client.connect(b)
  try {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["search_chats"])
    const search = await client.callTool({
      name: "search_chats",
      arguments: { query: "unique-fixture-query" },
    })
    expect(search.isError).toBeFalsy()
  } finally {
    await client.close()
    await server.close()
  }
})

test("CLI and stdio MCP run from another cwd with inherited profile restrictions", async () => {
  const { config, root, env } = setup()
  rollout(config, 0, "cli-session", [record("needle from CLI")])
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
    const result = await client.callTool({ name: "search_chats", arguments: { query: "needle" } })
    const content = result.content as { text: string }[]
    expect(JSON.parse(content[0]!.text).hits[0].excerpt).toBe("needle from CLI")
    const invalid = await client.callTool({
      name: "search_chats",
      arguments: { query: "needle", limit: 101 },
    })
    expect(invalid.isError).toBe(true)
  } finally {
    await client.close()
  }
})
