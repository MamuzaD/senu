import type { Config } from "../config.ts"
import { claimLock, getSnapshot, profileKey, refreshLocked } from "./cache.ts"

const HELP = `usage: senu usage [--json]
       senu usage refresh [profile] [--locked]

Opens the usage popup. --json prints each profile's snapshot instead.
refresh fetches now and updates the cache; profile is a key like codex-work.
`

export async function usageCommand(args: string[], config: Config): Promise<number> {
  const { profiles } = config.usage

  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP)
    return 0
  }

  if (args[0] === "refresh") {
    const key = args.slice(1).find((a) => !a.startsWith("-"))
    const locked = args.includes("--locked")
    const targets = key ? profiles.filter((p) => profileKey(p) === key) : profiles
    if (!targets.length) {
      console.error(`senu usage: no profile "${key}" (have ${profiles.map(profileKey).join(", ")})`)
      return 2
    }
    // --locked: the parent that spawned us already holds the lock
    await Promise.all(targets.map((p) => (locked || claimLock(p) ? refreshLocked(p) : null)))
    return 0
  }

  if (args.includes("--json")) {
    const snapshots = await Promise.all(profiles.map(getSnapshot))
    const out = Object.fromEntries(profiles.map((p, i) => [profileKey(p), snapshots[i]]))
    console.log(JSON.stringify(out, null, 2))
    return 0
  }

  const { runUsagePopup } = await import("./popup.tsx")
  return runUsagePopup(profiles)
}
