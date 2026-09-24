import { describe, expect, test } from "bun:test"
import { agentFromArgv } from "../../src/detect/panes.ts"

describe("agentFromArgv", () => {
  const cases: [string, string | null][] = [
    ["claude", "claude"],
    ["/Users/me/.local/share/claude/versions/2.1.280", null],
    ["claude --resume", "claude"],
    ["claude-code", "claude"],
    ["codex --config x=1", "codex"],
    // the live Codex panes: fnm's node running the codex bin script
    ["node /Users/me/.local/state/fnm_multishells/1_2/bin/codex --config cli_auth_credentials_store=file", "codex"],
    ["node --require ./hook.js /usr/local/lib/node_modules/@openai/codex/bin/codex.js", "codex"],
    ["bun /opt/bin/claude", "claude"],
    ["node -- /opt/bin/codex", "codex"],
    ["python3 /opt/bin/codex", "codex"],
    // inline code is never an agent, whatever it mentions
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
