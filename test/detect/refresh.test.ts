import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Config } from "~/config.ts"
import { bundledManifest } from "~/detect/manifest.ts"
import claudeToml from "~/detect/manifests/claude.toml" with { type: "text" }
import codexToml from "~/detect/manifests/codex.toml" with { type: "text" }
import {
  manifestsCommand,
  MIRROR,
  PRIMARY,
  refreshAgent,
  syncedRecently,
  type Fetcher,
} from "~/detect/refresh.ts"
import { compareVersions } from "~/version.ts"

const bundled = { claude: claudeToml as string, codex: codexToml as string }
const codexVersion = bundledManifest("codex").manifest.version!

const codexAt = (version: string, extra = "") =>
  bundled.codex.replace(/^version = ".*"$/m, `version = "${version}"`) + extra

const serve =
  (files: Record<string, string>): Fetcher =>
  async (url) => {
    const text = files[url]
    if (text === undefined) throw new Error("HTTP 404")
    return text
  }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "senu-refresh-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const override = (agent: string) => join(dir, "detection", `${agent}.toml`)
const opts = (files: Record<string, string>, check = false) => ({
  fetch: serve(files),
  dir: join(dir, "detection"),
  check,
})

describe("compareVersions", () => {
  test("numeric by segment", () => expect(compareVersions("2026.9.10", "2026.9.9")).toBe(1))
  test("missing segments are zero", () => expect(compareVersions("1.0", "1")).toBe(0))
  test("older", () => expect(compareVersions("2026.09.11.1", "2026.09.23.1")).toBe(-1))
})

describe("refreshAgent", () => {
  test("upstream equal to the bundled copy writes nothing", async () => {
    const o = await refreshAgent("codex", opts({ [`${PRIMARY}/codex.toml`]: bundled.codex }))
    expect(o.status).toBe("current")
    expect(existsSync(override("codex"))).toBe(false)
  })

  test("a newer upstream is written as the override", async () => {
    const newer = codexAt("2999.1.1.1")
    const o = await refreshAgent("codex", opts({ [`${PRIMARY}/codex.toml`]: newer }))
    expect(o.status).toBe("updated")
    expect(readFileSync(override("codex"), "utf8")).toBe(newer)
  })

  test("falls back to the GitHub mirror", async () => {
    const asked: string[] = []
    const get = serve({ [`${MIRROR}/codex.toml`]: codexAt("2999.1.1.1") })
    const o = await refreshAgent("codex", {
      ...opts({}),
      fetch: async (url) => {
        asked.push(url)
        return get(url)
      },
    })
    expect(o.status).toBe("updated")
    // pinned literally: herdr has moved this directory before
    expect(asked).toEqual([
      "https://herdr.dev/agent-detection/codex.toml",
      "https://raw.githubusercontent.com/herdrdev/herdr/HEAD/distribution/agent-detection/codex.toml",
    ])
  })

  test("both down is a failure", async () => {
    const o = await refreshAgent("codex", opts({}))
    expect(o.status).toBe("failed")
    expect(o.message).toContain("mirror")
  })

  test("a broken upstream never replaces a good override", async () => {
    const good = codexAt("2999.1.1.1")
    await refreshAgent("codex", opts({ [`${PRIMARY}/codex.toml`]: good }))
    for (const bad of [
      "not = [toml",
      codexAt("3000.1", '\n[[rules]]\nid = "x"\nregion = "nowhere"\ncontains = ["a"]\n'),
      bundled.claude,
    ]) {
      const o = await refreshAgent("codex", opts({ [`${PRIMARY}/codex.toml`]: bad }))
      expect(o.status).toBe("failed")
      expect(readFileSync(override("codex"), "utf8")).toBe(good)
    }
  })

  test("a manifest needing a newer engine is refused", async () => {
    const future = codexAt("2999.1.1.1").replace(
      /^min_engine_version = \d+$/m,
      "min_engine_version = 99",
    )
    const o = await refreshAgent("codex", opts({ [`${PRIMARY}/codex.toml`]: future }))
    expect(o.status).toBe("failed")
    expect(o.message).toContain("engine")
  })

  test("a downgrade is refused", async () => {
    const o = await refreshAgent(
      "codex",
      opts({ [`${PRIMARY}/codex.toml`]: codexAt("2000.1.1.1") }),
    )
    expect(o.status).toBe("failed")
    expect(o.message).toContain("older")
  })

  test("same version, different content is refused", async () => {
    const o = await refreshAgent(
      "codex",
      opts({ [`${PRIMARY}/codex.toml`]: codexAt(codexVersion, "\n# changed\n") }),
    )
    expect(o.status).toBe("failed")
    expect(o.message).toContain("version bump")
  })

  test("an unreadable override may be replaced", async () => {
    mkdirSync(join(dir, "detection"), { recursive: true })
    writeFileSync(override("codex"), "garbage")
    const o = await refreshAgent(
      "codex",
      opts({ [`${PRIMARY}/codex.toml`]: codexAt("2000.1.1.1") }),
    )
    expect(o.status).toBe("updated")
    expect(readFileSync(`${override("codex")}.bak`, "utf8")).toBe("garbage")
  })

  test("--check reports drift and writes nothing", async () => {
    const o = await refreshAgent(
      "codex",
      opts({ [`${PRIMARY}/codex.toml`]: codexAt("2999.1.1.1") }, true),
    )
    expect(o.status).toBe("drift")
    expect(existsSync(override("codex"))).toBe(false)
  })
})

describe("manifestsCommand", () => {
  const config = {} as Config
  const upstream = {
    [`${PRIMARY}/claude.toml`]: bundled.claude,
    [`${PRIMARY}/codex.toml`]: codexAt("2999.1.1.1"),
  }
  const run = (args: string[], files: Record<string, string> = upstream, now = 1_800_000_000_000) =>
    manifestsCommand(["refresh", ...args], config, {
      fetch: serve(files),
      dir: join(dir, "detection"),
      stamp: join(dir, "last-sync"),
      now,
    })

  test("check exits 1 on drift, without a stamp", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    expect(await run(["--check"])).toBe(1)
    log.mockRestore()
    expect(existsSync(join(dir, "last-sync"))).toBe(false)
  })

  test("a clean sync stamps; --daily then skips for a day", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    expect(await run([])).toBe(0)
    expect(syncedRecently(join(dir, "last-sync"), 1_800_000_000_000 + 3600_000)).toBe(true)
    let fetched = false
    const spy: Fetcher = async () => {
      fetched = true
      throw new Error("no")
    }
    expect(
      await manifestsCommand(["refresh", "--daily"], config, {
        fetch: spy,
        dir,
        stamp: join(dir, "last-sync"),
        now: 1_800_000_000_000 + 3600_000,
      }),
    ).toBe(0)
    expect(fetched).toBe(false)
    expect(
      await manifestsCommand(["refresh", "--daily"], config, {
        fetch: spy,
        dir,
        stamp: join(dir, "last-sync"),
        now: 1_800_000_000_000 + 25 * 3600_000,
      }),
    ).toBe(3)
    expect(fetched).toBe(true)
    log.mockRestore()
  })

  test("a failed sync doesn't stamp", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    expect(await run([], {})).toBe(3)
    log.mockRestore()
    expect(existsSync(join(dir, "last-sync"))).toBe(false)
  })
})
