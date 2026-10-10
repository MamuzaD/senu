import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { stateDir } from "~/paths.ts"
import { compareVersions } from "~/version.ts"

import { version } from "../../package.json"

/**
 * Release checks against GitHub. The watch daemon refreshes the cached newest
 * version once a day; help, `senu --version`, and the vision and threads popups
 * read it to mention or offer an update without touching the network.
 */

export const REPO = "MamuzaD/senu"
export const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`

const DAY_MS = 24 * 60 * 60 * 1000

export const statePath = join(stateDir, "update.json")

export interface UpdateState {
  /** Epoch ms of the last successful check. */
  checked: number
  /** Newest release, without the leading v. */
  latest: string
  /** A release skipped until the next one comes out. */
  dismissed?: string
}

export type JsonFetcher = (url: string) => Promise<unknown>

export const httpJson: JsonFetcher = async (url) => {
  const res = await fetch(url, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function latestVersion(get: JsonFetcher = httpJson): Promise<string> {
  const { tag_name: tag } = (await get(LATEST_URL)) as { tag_name?: unknown }
  if (typeof tag !== "string") throw new Error("release has no tag")
  const latest = tag.replace(/^v/, "")
  // Checked here so a tag compareVersions can't read (v0.2.0-hotfix) is never cached.
  if (!/^\d+(\.\d+)*$/.test(latest)) throw new Error(`unexpected release tag ${tag}`)
  return latest
}

export function readState(path = statePath): UpdateState | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UpdateState
  } catch {
    return null
  }
}

export function writeState(state: UpdateState, path = statePath) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state)}\n`)
  renameSync(tmp, path)
}

export const isNewer = (latest: string, current = version) => compareVersions(latest, current) > 0

export interface CheckOptions {
  fetch?: JsonFetcher
  path?: string
  now?: number
  /** Ask GitHub even if the cached answer is under a day old. */
  force?: boolean
}

/** The newest release, from the cache when it's fresh. Throws if the check fails. */
export async function checkLatest(opts: CheckOptions = {}): Promise<UpdateState> {
  const path = opts.path ?? statePath
  const now = opts.now ?? Date.now()
  const cached = readState(path)
  if (cached && !opts.force && now - cached.checked < DAY_MS) return cached
  const latest = await latestVersion(opts.fetch)
  // Re-read: a popup may have dismissed a release while this was fetching.
  const state: UpdateState = { ...readState(path), checked: now, latest }
  writeState(state, path)
  return state
}

/** The cached newest release when it's newer than this build, else null. */
export function newerRelease(path = statePath, current = version): string | null {
  const state = readState(path)
  return state && isNewer(state.latest, current) ? state.latest : null
}

/** A newer release to ask about when a popup opens: one not skipped until the next. */
export function promptRelease(path = statePath, current = version): string | null {
  const state = readState(path)
  if (!state || !isNewer(state.latest, current) || state.dismissed === state.latest) return null
  return state.latest
}

/** Stops asking about `latest`; a later release asks again. */
export function dismiss(latest: string, path = statePath) {
  const state = readState(path)
  if (state) writeState({ ...state, dismissed: latest }, path)
}
