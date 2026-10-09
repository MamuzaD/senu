import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Config } from "~/config.ts"
import {
  installCommand,
  installedBinary,
  scriptUrl,
  updateCommand,
  type Runner,
} from "~/update/command.ts"
import {
  checkLatest,
  LATEST_URL,
  dismiss,
  newerRelease,
  promptRelease,
  readState,
  type JsonFetcher,
} from "~/update/release.ts"

import { version } from "../../package.json"

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "senu-update-"))
  path = join(dir, "update.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
// macOS's tmpdir is itself a symlink (/var -> /private/var).
const realDir = () => realpathSync(dir)

const release = (tag: string) => {
  const calls: string[] = []
  const get: JsonFetcher = async (url) => {
    calls.push(url)
    return { tag_name: tag }
  }
  return { get, calls }
}

describe("checkLatest", () => {
  test("strips the v and caches the answer", async () => {
    const { get, calls } = release("v9.9.9")
    const state = await checkLatest({ fetch: get, path, now: 1000 })
    expect(state.latest).toBe("9.9.9")
    expect(calls).toEqual([LATEST_URL])
    expect(readState(path)).toEqual({ checked: 1000, latest: "9.9.9" })
  })

  test("a tag that isn't a plain version is refused, not cached", async () => {
    const { get } = release("v0.2.0-hotfix")
    const err = await checkLatest({ fetch: get, path }).catch((e: unknown) => e)
    expect(String(err)).toContain("unexpected release tag v0.2.0-hotfix")
    expect(readState(path)).toBeNull()
  })

  test("a check under a day old is reused", async () => {
    const { get, calls } = release("v9.9.9")
    await checkLatest({ fetch: get, path, now: 0 })
    await checkLatest({ fetch: get, path, now: 60_000 })
    expect(calls).toHaveLength(1)
  })

  test("force asks GitHub again", async () => {
    writeFileSync(path, JSON.stringify({ checked: 0, latest: "1.0.0" }))
    const { get } = release("v2.0.0")
    expect(await checkLatest({ fetch: get, path, now: 1, force: true })).toEqual({
      checked: 1,
      latest: "2.0.0",
    })
  })
})

describe("newerRelease", () => {
  test("null without a cache", () => expect(newerRelease(path)).toBeNull())

  test("null when the cache is not newer", () => {
    writeFileSync(path, JSON.stringify({ checked: 0, latest: "0.1.0" }))
    expect(newerRelease(path, "0.1.0")).toBeNull()
  })

  test("the cached version when newer", () => {
    writeFileSync(path, JSON.stringify({ checked: 0, latest: "0.2.0" }))
    expect(newerRelease(path, "0.1.0")).toBe("0.2.0")
  })
})

describe("promptRelease", () => {
  test("asks every time until dismissed", () => {
    writeFileSync(path, JSON.stringify({ checked: 0, latest: "0.2.0" }))
    expect(promptRelease(path, "0.1.0")).toBe("0.2.0")
    expect(promptRelease(path, "0.1.0")).toBe("0.2.0")
    dismiss("0.2.0", path)
    expect(promptRelease(path, "0.1.0")).toBeNull()
    expect(newerRelease(path, "0.1.0")).toBe("0.2.0")
  })

  test("a later release asks again, and a check keeps what was dismissed", async () => {
    writeFileSync(path, JSON.stringify({ checked: 0, latest: "0.2.0", dismissed: "0.2.0" }))
    await checkLatest({ fetch: release("v0.3.0").get, path, now: 1, force: true })
    expect(readState(path)?.dismissed).toBe("0.2.0")
    expect(promptRelease(path, "0.1.0")).toBe("0.3.0")
  })

  test("nothing to ask when up to date", () => {
    writeFileSync(path, JSON.stringify({ checked: 0, latest: "0.1.0" }))
    expect(promptRelease(path, "0.1.0")).toBeNull()
  })
})

describe("installedBinary", () => {
  test("a binary named senu, directly or through a symlink", () => {
    writeFileSync(join(dir, "senu"), "")
    symlinkSync(join(dir, "senu"), join(dir, "link"))
    expect(installedBinary(join(dir, "senu"))).toBe(join(realDir(), "senu"))
    expect(installedBinary(join(dir, "link"))).toBe(join(realDir(), "senu"))
  })

  test("not a symlink named senu pointing at a renamed download", () => {
    writeFileSync(join(dir, "senu-darwin-arm64"), "")
    symlinkSync(join(dir, "senu-darwin-arm64"), join(dir, "senu"))
    expect(installedBinary(join(dir, "senu"))).toBeNull()
  })
})

describe("updateCommand", () => {
  const config = {} as Config

  const run = (args: string[], tag: string, exit = 0) => {
    const calls: { url: string; env: Record<string, string> }[] = []
    const runner: Runner = async (url, env) => {
      calls.push({ url, env })
      return exit
    }
    const target = join(dir, "bin", "senu")
    const code = updateCommand(args, config, { fetch: release(tag).get, path, run: runner, target })
    return { calls, code }
  }

  let log: ReturnType<typeof spyOn>
  let out: ReturnType<typeof spyOn>
  // Coloured when the tests run in a terminal, as they do from the git hooks.
  const printed = () => Bun.stripANSI(out.mock.calls.flat().join())
  let err: ReturnType<typeof spyOn>
  beforeEach(() => {
    log = spyOn(console, "log").mockImplementation(() => {})
    out = spyOn(process.stdout, "write").mockImplementation(() => true)
    err = spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => {
    log.mockRestore()
    out.mockRestore()
    err.mockRestore()
  })

  test("already latest runs nothing", async () => {
    const { calls, code } = run([], `v${version}`)
    expect(await code).toBe(0)
    expect(calls).toEqual([])
  })

  test("--check reports without installing", async () => {
    const { calls, code } = run(["--check"], "v999.0.0")
    expect(await code).toBe(0)
    expect(calls).toEqual([])
    expect(printed()).toContain(`senu 999.0.0 is out (you have ${version})`)
  })

  test("runs the release's install.sh, pinned, into this binary's directory", async () => {
    const { calls, code } = run([], "v999.0.0")
    expect(await code).toBe(0)
    expect(calls).toEqual([
      {
        url: scriptUrl("v999.0.0"),
        env: { SENU_VERSION: "v999.0.0", SENU_INSTALL_DIR: join(dir, "bin") },
      },
    ])
    expect(installCommand("v999.0.0")).toContain("/MamuzaD/senu/v999.0.0/install.sh | sh")
    expect(printed()).toContain(
      `updating senu ${version} → 999.0.0 via ${installCommand("v999.0.0")}`,
    )
  })

  test("a failed install.sh fails the update", async () => {
    const { code } = run([], "v999.0.0", 1)
    expect(await code).toBe(1)
    expect(err.mock.calls.flat().join()).toContain("install.sh failed")
  })

  test("unknown flags print usage", async () => {
    const write = spyOn(process.stderr, "write").mockImplementation(() => true)
    expect(await updateCommand(["--force"], config, { path })).toBe(2)
    write.mockRestore()
  })
})
