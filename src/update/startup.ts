import { selfCommand } from "~/paths.ts"

import { checkLatest, DAY_MS, readState, statePath } from "./release.ts"

export const RELEASE_CHECK_ARG = "--check-release"

/** A detached helper lets short commands refresh the cache without waiting on GitHub. */
export function refreshOnStartup(command = selfCommand(), path = statePath, now = Date.now()) {
  const cached = readState(path)
  if (cached && now - cached.checked < DAY_MS) return
  try {
    Bun.spawn([...command, RELEASE_CHECK_ARG], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref()
  } catch {
    // Update discovery must never prevent a command from running.
  }
}

export async function refreshRelease() {
  await checkLatest().catch(() => {})
}
