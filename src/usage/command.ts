import type { Config } from "../config.ts"
import { claimLock, getSnapshot, profileKey, refreshLocked } from "./cache.ts"
import { formatTokens } from "./format.ts"
import { claimTodayLock, refreshTodayLocked, scanToday } from "./today.ts"

const HELP = `usage: senu vision [--json]
       senu vision refresh [profile] [--locked]
       senu vision today [profile...] [--json]

Opens the usage popup. --json prints each profile's snapshot instead.
refresh fetches now and updates the cache; profile is a key like codex-work.
today scans the transcripts now and prints today's estimated spend and tokens.
`

export async function usageCommand(args: string[], config: Config): Promise<number> {
  const { profiles } = config.usage

  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP)
    return 0
  }

  if (args[0] === "refresh") {
    const key = args.slice(1).find((a) => !a.startsWith("-"))
    // --locked transfers a lock already claimed by the parent; refreshLocked releases it.
    const locked = args.includes("--locked")
    const targets = key ? profiles.filter((p) => profileKey(p) === key) : profiles
    if (!targets.length) {
      console.error(`senu vision: no profile "${key}" (have ${profiles.map(profileKey).join(", ")})`)
      return 2
    }
    await Promise.all(targets.map((p) => (locked || claimLock(p) ? refreshLocked(p) : null)))
    return 0
  }

  if (args[0] === "today") {
    const keys = args.slice(1).filter((a) => !a.startsWith("-"))
    const targets = keys.length ? profiles.filter((p) => keys.includes(profileKey(p))) : profiles
    if (!targets.length) {
      console.error(`senu vision: no profile "${keys.join(", ")}" (have ${profiles.map(profileKey).join(", ")})`)
      return 2
    }
    // --locked transfers the parent's profile locks; refreshTodayLocked releases each one.
    const locked = args.includes("--locked")
    const results = await Promise.all(
      targets.map(async (p) => {
        const started = performance.now()
        const today = await (locked || claimTodayLock(p) ? refreshTodayLocked(p) : scanToday(p))
        return { key: profileKey(p), ms: Math.round(performance.now() - started), ...today }
      }),
    )
    if (args.includes("--refresh")) return 0
    if (args.includes("--json")) {
      console.log(JSON.stringify(results, null, 2))
      return 0
    }
    for (const r of results) {
      const cost = r.costUsd == null ? "no prices" : `$${r.costUsd.toFixed(2)}`
      const cached = r.tokens ? ` (${Math.round((100 * r.cachedTokens) / r.tokens)}% cached)` : ""
      const unpriced = r.unpricedTokens ? `, ${formatTokens(r.unpricedTokens)} unpriced` : ""
      console.log(`${r.key.padEnd(16)} ${r.day}  ${cost.padStart(9)}  ${formatTokens(r.tokens)} tok${cached}${unpriced}  ${r.ms}ms`)
    }
    return 0
  }

  if (args.includes("--json")) {
    const snapshots = await Promise.all(profiles.map(getSnapshot))
    const out = Object.fromEntries(profiles.map((p, i) => [profileKey(p), snapshots[i]]))
    console.log(JSON.stringify(out, null, 2))
    return 0
  }

  const { runUsagePopup } = await import("./popup.tsx")
  return runUsagePopup(profiles, config.usage.scene)
}
