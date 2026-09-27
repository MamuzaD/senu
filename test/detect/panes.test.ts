import { describe, expect, test } from "bun:test"

import { agentFromArgv, agentFromProcess, processArgv } from "~/detect/panes.ts"

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
