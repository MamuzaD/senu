import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { planJump, type Client } from "~/agents/actions.ts"
import { appleString, raiseTabScript } from "~/agents/ghostty.ts"
import { loadConfig } from "~/config.ts"

const clients: Client[] = [
  { name: "/dev/ttys001", session: "work", termname: "xterm-ghostty" },
  { name: "/dev/ttys002", session: "api", termname: "xterm-ghostty" },
  { name: "/dev/ttys003", session: "ssh", termname: "xterm-256color" },
]
const on = { raiseGhosttyTab: true, platform: "darwin" }

describe("planJump", () => {
  test("the session you're in: just select the window", () => {
    expect(planJump({ session: "work" }, clients, "/dev/ttys001", on)).toBe("here")
  })
  test("shown in another Ghostty tab: raise it", () => {
    expect(planJump({ session: "api" }, clients, "/dev/ttys001", on)).toBe("raise")
  })
  test("detached, or in a non-Ghostty client: switch", () => {
    expect(planJump({ session: "gone" }, clients, "/dev/ttys001", on)).toBe("switch")
    expect(planJump({ session: "ssh" }, clients, "/dev/ttys001", on)).toBe("switch")
  })
  test("the toggle and the platform are respected", () => {
    expect(
      planJump({ session: "api" }, clients, "/dev/ttys001", { ...on, raiseGhosttyTab: false }),
    ).toBe("switch")
    expect(
      planJump({ session: "api" }, clients, "/dev/ttys001", { ...on, platform: "linux" }),
    ).toBe("switch")
  })
})

describe("the Ghostty script", () => {
  test("quotes the session", () => {
    expect(appleString('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(raiseTabScript('we"ird')).toContain('set wanted to "we\\"ird"')
  })

  test.skipIf(
    process.platform !== "darwin" ||
      !Bun.which("osacompile") ||
      !Bun.file("/Applications/Ghostty.app/Contents/Resources/Ghostty.sdef").size,
  )("compiles with osacompile", () => {
    const out = join(mkdtempSync(join(tmpdir(), "senu-")), "raise.scpt")
    const r = Bun.spawnSync(["osacompile", "-o", out, "-e", raiseTabScript('my "session"')])
    expect(r.stderr.toString()).toBe("")
    expect(r.exitCode).toBe(0)
  })
})

describe("[agents] config", () => {
  const write = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "senu-")), "config.toml")
    writeFileSync(path, text)
    return path
  }
  test("raise_ghostty_tab defaults to true", () => {
    expect(loadConfig(write("")).agents.raiseGhosttyTab).toBe(true)
    expect(loadConfig("/nonexistent/config.toml").agents.raiseGhosttyTab).toBe(true)
  })
  test("and can be turned off", () => {
    expect(loadConfig(write("[agents]\nraise_ghostty_tab = false\n")).agents.raiseGhosttyTab).toBe(
      false,
    )
  })
  test("rejects a non-boolean", () => {
    expect(() => loadConfig(write('[agents]\nraise_ghostty_tab = "yes"\n'))).toThrow(
      "expected true or false",
    )
  })
})
