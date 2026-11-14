import { hasUsage, type Config } from "~/config.ts"
import { selectProfiles } from "~/profiles.ts"
import { printHelp } from "~/ui/help.ts"

import { claimLock, getSnapshot, profileKey, refreshLocked } from "./cache.ts"
import { formatTokens } from "./format.ts"
import { claimTodayLock, refreshTodayLocked, scanToday } from "./today.ts"

const HELP = `usage: senu vision [flags]
       senu vision refresh [flags]
       senu vision today [flags]

Shows Codex and Claude usage limits and today's cost.

  refresh             fetch limits now, for selected profiles or all
  today               print today's estimated spend and tokens
  --json              print each profile's snapshot
  --profile name|key  select by name or key, repeatable
`

export async function usageCommand(args: string[], config: Config): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    await printHelp(process.stdout, HELP)
    return 0
  }

  const keys: string[] = []
  const command = args[0] === "refresh" || args[0] === "today" ? args[0] : undefined
  const locked = args.includes("--locked")
  const available = config.profiles.filter(hasUsage)
  let profiles: typeof available
  try {
    for (let i = command ? 1 : 0; i < args.length; i++) {
      const a = args[i]!
      if (a === "--profile") {
        const value = args[++i]
        if (!value || value.startsWith("-")) throw new Error("missing value for --profile")
        keys.push(value)
      } else if (["--json", "--locked", "--refresh"].includes(a)) continue
      // Old watchers hand their already-claimed locks to the new binary.
      else if (locked && command && !a.startsWith("-")) keys.push(a)
      else throw new Error(`unexpected argument ${a}`)
    }
    profiles = selectProfiles(available, keys)
  } catch (e) {
    console.error(`senu vision: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }

  if (args[0] === "refresh") {
    const targets = profiles
    await Promise.all(targets.filter((p) => locked || claimLock(p)).map((p) => refreshLocked(p)))
    return 0
  }

  if (args[0] === "today") {
    const targets = profiles
    const results = await Promise.all(
      // oxlint-disable-next-line oxc/no-map-spread -- keeps key and ms first in --json output
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
      console.log(
        `${r.key.padEnd(16)} ${r.day}  ${cost.padStart(9)}  ${formatTokens(r.tokens)} tok${cached}${unpriced}  ${r.ms}ms`,
      )
    }
    return 0
  }

  if (args.includes("--json")) {
    const snapshots = await Promise.all(profiles.map(getSnapshot))
    const out = Object.fromEntries(profiles.map((p, i) => [profileKey(p), snapshots[i]]))
    console.log(JSON.stringify(out, null, 2))
    return 0
  }

  if (!profiles.length) {
    console.log("no profiles with usage support (Codex or Claude)")
    return 0
  }
  const { runUsagePopup } = await import("./popup.tsx")
  return runUsagePopup(profiles, config.usage.scene)
}
