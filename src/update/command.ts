import { realpathSync } from "node:fs"
import { basename, dirname } from "node:path"

import type { Config } from "~/config.ts"
import { compiled } from "~/paths.ts"
import { paint, write } from "~/ui/banner.ts"
import { brand, states } from "~/ui/theme.ts"

import { version } from "../../package.json"
import { checkLatest, isNewer, REPO, type CheckOptions } from "./release.ts"

const HELP = `usage: senu update [--check]

Runs the latest release's install.sh, which downloads that release, checks it
against its SHA256SUMS, and replaces this senu binary. A running watcher
restarts on the new build by itself.

--check  only report whether a newer release is out
`

export const scriptUrl = (tag: string) =>
  `https://raw.githubusercontent.com/${REPO}/${tag}/install.sh`

/** What `senu update` runs, as the README would type it. */
export const installCommand = (tag: string) => `curl -fsSL ${scriptUrl(tag)} | sh`

/** Runs the install script at `url`; resolves to its exit code. */
export type Runner = (url: string, env: Record<string, string>) => Promise<number>

// Downloads the script before running it: in `curl … | sh` a failed download
// still exits 0, since sh happily runs the empty script.
const runScript: Runner = async (url, env) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`could not download install.sh: HTTP ${res.status}`)
  return Bun.spawn(["sh"], {
    env: { ...process.env, ...env },
    stdio: [new Blob([await res.text()]), "inherit", "inherit"],
  }).exited
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface InstallOptions {
  run?: Runner
  /** The binary to replace; this one by default. */
  target?: string
}

/**
 * This binary's real path if install.sh could have put it there, which always
 * names it senu; null for a symlink to a renamed download. Like Codex, only an
 * install it recognizes is offered an update.
 */
export function installedBinary(exe = process.execPath): string | null {
  const path = realpathSync(exe)
  return basename(path) === "senu" ? path : null
}

/** Runs `latest`'s install.sh over this binary, saying so first. */
export async function runUpdate(latest: string, opts: InstallOptions = {}): Promise<number> {
  const tag = `v${latest}`
  const command = installCommand(tag)
  write(
    process.stdout,
    `${paint([
      ["updating senu ", brand.papyrus],
      [version, brand.dusk],
      [" → ", brand.papyrus],
      [latest, states.done.fg, true],
      [" via ", brand.papyrus],
      [command, brand.gold],
    ])}\n`,
  )
  // Pin the release just checked, and reinstall wherever this binary lives.
  const target = opts.target ?? realpathSync(process.execPath)
  const env = { SENU_VERSION: tag, SENU_INSTALL_DIR: dirname(target) }
  let code: number
  try {
    code = await (opts.run ?? runScript)(scriptUrl(tag), env)
  } catch (err) {
    console.error(`senu update: ${why(err)}`)
    return 1
  }
  if (code !== 0) console.error(`senu update: install.sh failed (exit ${code})`)
  return code === 0 ? 0 : 1
}

export async function updateCommand(
  args: string[],
  _config: Config,
  opts: CheckOptions & InstallOptions = {},
): Promise<number> {
  if (args.some((a) => a !== "--check")) {
    const help = args.includes("-h") || args.includes("--help")
    ;(help ? process.stdout : process.stderr).write(HELP)
    return help ? 0 : 2
  }

  let latest: string
  try {
    latest = (await checkLatest({ ...opts, force: true })).latest
  } catch (err) {
    console.error(`senu update: could not reach GitHub: ${why(err)}`)
    return 1
  }
  if (!isNewer(latest)) {
    console.log(`senu ${version} is the latest`)
    return 0
  }
  if (args.includes("--check")) {
    write(process.stdout, `${availableLine(latest)}\n`)
    return 0
  }
  // From source, execPath is bun itself; install.sh would drop senu beside it.
  if (!compiled && !opts.target) {
    console.error(`senu update: running from source; update ${version} -> ${latest} with git pull`)
    return 1
  }
  if (!opts.target && !installedBinary()) {
    console.error(
      `senu update: ${realpathSync(process.execPath)} isn't named senu, so install.sh can't replace it; reinstall with install.sh or update it the way you installed it`,
    )
    return 1
  }
  return runUpdate(latest, opts)
}

/** "senu 0.2.0 is out (you have 0.1.0) · run senu update", coloured. */
export const availableLine = (latest: string) =>
  paint([
    [`senu ${latest}`, states.done.fg, true],
    [` is out (you have ${version}) · run `, brand.dusk],
    ["senu update", brand.gold],
  ])
