import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { version } from "../package.json"

const cli = join(import.meta.dir, "..", "src", "cli.ts")

for (const flag of ["--version", "-v", "version"]) {
  test(`${flag} prints the package version from any cwd`, () => {
    const run = Bun.spawnSync([process.execPath, cli, flag], { cwd: tmpdir() })
    expect(run.exitCode).toBe(0)
    expect(run.stdout.toString()).toBe(`senu ${version}\n`)
  })
}
