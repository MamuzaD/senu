import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { refreshOnStartup } from "~/update/startup.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "senu-startup-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("a fresh release cache does not start another process", () => {
  const path = join(dir, "update.json")
  writeFileSync(path, JSON.stringify({ checked: 1000, latest: "9.9.9" }))
  const spawn = spyOn(Bun, "spawn")
  try {
    refreshOnStartup(["does-not-exist"], path, 1001)
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    spawn.mockRestore()
  }
})

test("a stale cache refresh survives the short command without keeping its pipes open", async () => {
  const path = join(dir, "update.json")
  const done = join(dir, "done")
  writeFileSync(path, JSON.stringify({ checked: 0, latest: "1.0.0" }))
  const helper = `await Bun.sleep(500); await Bun.write(${JSON.stringify(done)}, JSON.stringify(process.argv));`
  const source = join(import.meta.dir, "../../src/update/startup.ts")
  const parent = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { refreshOnStartup } from ${JSON.stringify(source)};
    refreshOnStartup(${JSON.stringify([process.execPath, "-e", helper, "--"])}, ${JSON.stringify(path)}, ${24 * 60 * 60 * 1000});
    console.log("done");
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  expect(await new Response(parent.stdout).text()).toBe("done\n")
  expect(await parent.exited).toBe(0)
  expect(existsSync(done)).toBe(false)
  const deadline = Date.now() + 5000
  while (!existsSync(done) && Date.now() < deadline) await Bun.sleep(20)
  expect(existsSync(done)).toBe(true)
  expect(JSON.parse(readFileSync(done, "utf8"))).toContain("--check-release")
})

for (const fails of [false, true]) {
  test(`the internal helper is silent when fetching ${fails ? "fails" : "succeeds"}`, () => {
    const preload = join(dir, "fetch.ts")
    writeFileSync(
      preload,
      fails
        ? 'globalThis.fetch = async () => { throw new Error("offline") }'
        : 'globalThis.fetch = async () => new Response(JSON.stringify({ tag_name: "v9.9.9" }))',
    )
    const run = Bun.spawnSync(
      [
        process.execPath,
        "--preload",
        preload,
        join(import.meta.dir, "../../src/cli.ts"),
        "--check-release",
      ],
      {
        env: { ...process.env, XDG_STATE_HOME: dir },
      },
    )
    expect(run.exitCode).toBe(0)
    expect(run.stdout.toString()).toBe("")
    expect(run.stderr.toString()).toBe("")
    const path = join(dir, "senu/update.json")
    expect(existsSync(path)).toBe(!fails)
    if (!fails) expect(JSON.parse(readFileSync(path, "utf8")).latest).toBe("9.9.9")
  })
}
