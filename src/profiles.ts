import type { Profile } from "~/config.ts"

export const profileKey = (p: Profile) => `${p.kind}-${p.name.replace(/[^\w.-]/g, "_")}`

/** Repeated names and keys select a union, preserving configured order. */
export function selectProfiles<P extends Profile>(profiles: P[], values: string[] = []): P[] {
  if (!values.length) return profiles
  const selected = new Set<P>()
  const unknown: string[] = []
  for (const value of values) {
    const exact = profiles.filter((p) => profileKey(p) === value)
    const matches = exact.length ? exact : profiles.filter((p) => p.name === value)
    if (!matches.length) unknown.push(value)
    for (const p of matches) selected.add(p)
  }
  if (unknown.length)
    throw new Error(
      `no profile ${unknown.join(", ")} (have ${profiles.map(profileKey).join(", ")})`,
    )
  return profiles.filter((p) => selected.has(p))
}
