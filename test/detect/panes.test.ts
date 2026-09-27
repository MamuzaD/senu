import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Agent } from "~/detect/manifest.ts"
import {
  AgentCache,
  agentFromArgv,
  agentFromProcess,
  captureArgs,
  identifyAgents,
  listPanes,
  parseCaptures,
  processArgv,
  setTmuxSocket,
  type Pane,
} from "~/detect/panes.ts"

const pane: Pane = {
  id: "%1",
  pid: 101,
  command: "node",
  title: "",
  oscTitle: "",
  active: true,
  dead: false,
  session: "test",
  sessionAttached: true,
  windowId: "@1",
  windowIndex: 0,
  windowName: "test",
  windowActive: true,
  windowActivity: 0,
  aiState: "",
}

test("agent cache refreshes a runtime whose command name stays the same", async () => {
  let agent: Agent | null = "codex"
  let lookups = 0
  const cache = new AgentCache(async (panes) => {
    lookups++
    const found = agent
    return {
      agents: found ? panes.map((p) => ({ ...p, agent: found })) : [],
      unresolved: new Set<string>(),
    }
  })

  expect((await cache.identify([pane], 0))[0]?.agent).toBe("codex")
  agent = "claude"
  expect((await cache.identify([pane], 4_000))[0]?.agent).toBe("codex")
  expect(lookups).toBe(1)
  expect((await cache.identify([pane], 5_001))[0]?.agent).toBe("claude")
  expect(lookups).toBe(2)
})

test("agent cache retries an unresolved runtime and notices a changed command", async () => {
  let agent: Agent | null = null
  let lookups = 0
  const cache = new AgentCache(async (panes) => {
    lookups++
    const found = agent
    return {
      agents: found ? panes.map((p) => ({ ...p, agent: found })) : [],
      unresolved: new Set<string>(),
    }
  })

  expect(await cache.identify([pane], 0)).toEqual([])
  agent = "codex"
  expect(await cache.identify([pane], 4_000)).toEqual([])
  expect((await cache.identify([pane], 5_001))[0]?.agent).toBe("codex")
  expect(lookups).toBe(2)

  agent = "claude"
  expect((await cache.identify([{ ...pane, command: "claude" }], 5_002))[0]?.agent).toBe("claude")
  expect(lookups).toBe(3)
})

test("a failed refresh keeps a known agent and retries on the next poll", async () => {
  let result: "agent" | "unresolved" | "none" = "agent"
  let lookups = 0
  const cache = new AgentCache(async (panes) => {
    lookups++
    return {
      agents: result === "agent" ? panes.map((p) => ({ ...p, agent: "claude" as const })) : [],
      unresolved: result === "unresolved" ? new Set(panes.map((p) => p.id)) : new Set<string>(),
    }
  })

  expect((await cache.identify([pane], 0))[0]?.agent).toBe("claude")
  result = "unresolved"
  expect((await cache.identify([pane], 5_001))[0]?.agent).toBe("claude")
  expect((await cache.identify([pane], 5_002))[0]?.agent).toBe("claude")
  expect(lookups).toBe(3)

  result = "none"
  expect(await cache.identify([pane], 5_003)).toEqual([])
  expect(lookups).toBe(4)
})

test("a failed lookup for a changed command cannot reuse the previous identity", async () => {
  let fail = false
  const cache = new AgentCache(async (panes) => ({
    agents: fail ? [] : panes.map((p) => ({ ...p, agent: "codex" as const })),
    unresolved: fail ? new Set(panes.map((p) => p.id)) : new Set<string>(),
  }))

  expect((await cache.identify([pane], 0))[0]?.agent).toBe("codex")
  fail = true
  expect(await cache.identify([{ ...pane, command: "bun" }], 1)).toEqual([])
})

describe("agentFromArgv", () => {
  const cases: [string, string | null][] = [
    ["claude", "claude"],
    ["/Users/me/.local/share/claude/versions/2.1.280", null],
    ["claude --resume", "claude"],
    ["claude-code", "claude"],
    ["codex --config x=1", "codex"],
    [
      "node /Users/me/.local/state/fnm_multishells/1_2/bin/codex --config cli_auth_credentials_store=file",
      "codex",
    ],
    ["node --require ./hook.js /usr/local/lib/node_modules/@openai/codex/bin/codex.js", "codex"],
    ["bun /opt/bin/claude", "claude"],
    ["node -- /opt/bin/codex", "codex"],
    ["python3 /opt/bin/codex", "codex"],
    ["node -e codex", null],
    ["node --eval=codex", null],
    ["sh -c codex", null],
    ["python3 -m codex", null],
    ["-zsh", null],
    ["nvim codex.md", null],
    ["node server.js", null],
  ]
  for (const [argv, agent] of cases) {
    test(argv, () => expect(agentFromArgv(argv.split(" "))).toBe(agent as never))
  }
})

test("process classification reads argv only for runtime candidates", () => {
  let reads = 0
  const argv = () => {
    reads++
    return ["node", "/tmp/agent files/codex.js"]
  }
  expect(agentFromProcess("/usr/bin/sleep", argv)).toBeNull()
  expect(agentFromProcess("/usr/local/bin/claude", argv)).toBe("claude")
  expect(reads).toBe(0)
  expect(agentFromProcess("/usr/bin/node", argv)).toBe("codex")
  expect(reads).toBe(1)
})

test("version-named Claude executable is identified from its path", () => {
  const path = "/Users/me/.local/share/claude/versions/2.1.280"
  expect(agentFromProcess(path, () => [])).toBe("claude")
  expect(agentFromProcess("2.1.280", () => [path])).toBe("claude")
  expect(agentFromProcess("2.1.280", () => ["/opt/other/2.1.280"])).toBeNull()
})

test("processArgv preserves arguments containing spaces", async () => {
  const path = "/tmp/agent files/codex.js"
  const proc = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 2000)", "--", path], {
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    let argv: string[] = []
    for (let i = 0; i < 20; i++) {
      argv = processArgv(proc.pid)
      if (argv.includes(path)) break
      await Bun.sleep(20)
    }
    expect(argv).toContain(path)
    expect(agentFromArgv(["node", path])).toBe("codex")
  } finally {
    proc.kill()
    await proc.exited
  }
})

test.skipIf(!Bun.which("tmux"))("one chained capture returns every pane's screen", () => {
  const dir = mkdtempSync(join(tmpdir(), "senu-capture-"))
  const t = (...args: string[]) =>
    Bun.spawnSync(["tmux", "-S", join(dir, "sock"), "-f", "/dev/null", ...args])
  try {
    t("new-session", "-d", "-s", "cap", "-x", "80", "-y", "10", "printf 'screen A\\n'; sleep 60")
    t("new-window", "-d", "-t", "cap", "printf 'screen B\\n'; sleep 60")
    const ids = t("list-panes", "-s", "-t", "cap", "-F", "#{pane_id}")
      .stdout.toString()
      .trim()
      .split("\n")
    expect(ids).toHaveLength(2)
    let screens = new Map<string, string>()
    for (let i = 0; i < 40 && ![...screens.values()].join().includes("screen B"); i++) {
      screens = parseCaptures(t(...captureArgs(ids)).stdout.toString())
      Bun.sleepSync(25)
    }
    expect([...screens.keys()]).toEqual(ids)
    expect(screens.get(ids[0]!)).toStartWith("screen A\n")
    expect(screens.get(ids[1]!)).toStartWith("screen B\n")
  } finally {
    t("kill-server")
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a dead pane is not an agent, and the cache forgets one it had", async () => {
  const alive = { ...pane, id: "%7", command: "claude" }
  const cache = new AgentCache()
  expect((await cache.identify([alive], 0)).map((p) => p.agent)).toEqual(["claude"])
  expect(await cache.identify([{ ...alive, dead: true }], 1)).toEqual([])
  expect(await identifyAgents([{ ...alive, dead: true }])).toEqual([])
})

test.skipIf(!Bun.which("tmux"))("an agent that exits under remain-on-exit is dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "senu-dead-"))
  const sock = join(dir, "sock")
  const t = (...args: string[]) => Bun.spawnSync(["tmux", "-S", sock, "-f", "/dev/null", ...args])
  writeFileSync(join(dir, "codex.js"), "setTimeout(() => {}, 500)\n")
  try {
    t("new-session", "-d", "-s", "dead", "-c", dir, `${process.execPath} codex.js`)
    t("set-option", "-t", "dead", "remain-on-exit", "on")
    setTmuxSocket(["-S", sock])
    const cache = new AgentCache()
    let agents: string[] = []
    for (let i = 0; i < 40 && !agents.length; i++) {
      agents = (await cache.identify(await listPanes(), 0)).map((p) => p.agent)
      if (!agents.length) await Bun.sleep(25)
    }
    expect(agents).toEqual(["codex"])
    let panes = await listPanes()
    for (let i = 0; i < 80 && !panes[0]?.dead; i++) {
      await Bun.sleep(25)
      panes = await listPanes()
    }
    expect(panes[0]?.dead).toBe(true)
    expect(await cache.identify(panes, 60_000)).toEqual([])
  } finally {
    setTmuxSocket([])
    t("kill-server")
    rmSync(dir, { recursive: true, force: true })
  }
})
