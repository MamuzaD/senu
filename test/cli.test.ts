import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { version } from "../package.json"

const cli = join(import.meta.dir, "..", "src", "cli.ts")

/** Runs the CLI with its own state dir, holding `update` as the cached release check. */
function senu(args: string[], update?: object) {
  const state = mkdtempSync(join(tmpdir(), "senu-cli-"))
  if (update) {
    mkdirSync(join(state, "senu"))
    writeFileSync(join(state, "senu", "update.json"), JSON.stringify(update))
  }
  return Bun.spawnSync([process.execPath, cli, ...args], {
    cwd: tmpdir(),
    env: { ...process.env, XDG_STATE_HOME: state },
  })
}

for (const flag of ["--version", "-v", "version"]) {
  test(`${flag} prints the package version from any cwd`, () => {
    const run = senu([flag])
    expect(run.exitCode).toBe(0)
    expect(run.stdout.toString()).toBe(`senu ${version}\n`)
    expect(run.stderr.toString()).toBe("")
  })
}

test("--version mentions a newer release on stderr, without colours off a terminal", () => {
  const run = senu(["--version"], { checked: 0, latest: "999.0.0" })
  expect(run.stdout.toString()).toBe(`senu ${version}\n`)
  expect(run.stderr.toString()).toBe(
    `senu 999.0.0 is out (you have ${version}) · run senu update\n`,
  )
})
