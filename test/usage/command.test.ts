import { expect, spyOn, test } from "bun:test"

import { loadConfig } from "~/config.ts"
import { usageCommand } from "~/usage/command.ts"

test("usage commands exclude OpenCode profiles instead of fetching Claude usage", async () => {
  const config = loadConfig("/nonexistent/config.toml")
  config.profiles = [{ kind: "opencode", name: "only", home: "/unused/opencode" }]
  const log = spyOn(console, "log").mockImplementation(() => {})
  const error = spyOn(console, "error").mockImplementation(() => {})
  try {
    expect(await usageCommand(["--json"], config)).toBe(0)
    expect(log).toHaveBeenLastCalledWith("{}")
    expect(await usageCommand(["refresh", "opencode-only"], config)).toBe(2)
    expect(await usageCommand(["today", "opencode-only", "--json"], config)).toBe(2)
    expect(await usageCommand([], config)).toBe(0)
    expect(log).toHaveBeenLastCalledWith("no profiles with usage support (Codex or Claude)")
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
})
