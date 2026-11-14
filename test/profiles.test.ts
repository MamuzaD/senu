import { expect, test } from "bun:test"

import type { Profile } from "~/config.ts"
import { profileKey, selectProfiles } from "~/profiles.ts"
import { profileKey as cacheProfileKey } from "~/usage/cache.ts"

const profiles: Profile[] = [
  { kind: "codex", name: "work", home: "/unused/codex" },
  { kind: "claude", name: "work", home: "/unused/claude" },
  { kind: "claude", name: "codex-work", home: "/unused/collision" },
  { kind: "codex", name: "work team!", home: "/unused/team" },
]

test("listed and cached keys select profiles with punctuation in their names", () => {
  const p = profiles[3]!
  expect(profileKey(p)).toBe("codex-work_team_")
  expect(cacheProfileKey(p)).toBe(profileKey(p))
  expect(selectProfiles(profiles, [cacheProfileKey(p)])).toEqual([p])
  expect(selectProfiles(profiles, [p.name])).toEqual([p])
})

test("exact keys take precedence over names, while repeated values form an ordered union", () => {
  expect(selectProfiles(profiles, ["codex-work"])).toEqual([profiles[0]!])
  expect(selectProfiles(profiles, ["work"])).toEqual(profiles.slice(0, 2))
  expect(selectProfiles(profiles, ["claude-codex-work"])).toEqual([profiles[2]!])
  expect(selectProfiles(profiles, ["codex-work_team_", "work", "codex-work"])).toEqual([
    profiles[0]!,
    profiles[1]!,
    profiles[3]!,
  ])
  expect(() => selectProfiles(profiles, ["work", "missing"])).toThrow("no profile missing")
})
