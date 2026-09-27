import { rmSync } from "node:fs"
import { join } from "node:path"

import { AGENTS } from "~/detect/manifest.ts"
import { refreshAgent } from "~/detect/refresh.ts"

/**
 * Syncs the bundled manifests in src/detect/manifests with herdr's published
 * ones, through the same fetch, validation and no-downgrade checks as
 * `senu scout manifest refresh`. `--check` writes nothing and exits 1 on drift.
 */

const dir = join(import.meta.dir, "../src/detect/manifests")
const check = process.argv.includes("--check")

const outcomes = await Promise.all(AGENTS.map((agent) => refreshAgent(agent, { dir, check })))
for (const o of outcomes) {
  // refreshAgent backs up the file it replaces; the repo has git for that.
  rmSync(join(dir, `${o.agent}.toml.bak`), { force: true })
  console.log(`${o.status.padEnd(7)} ${o.agent}: ${o.message}`)
}

if (outcomes.some((o) => o.status === "failed")) process.exit(1)
if (outcomes.some((o) => o.status === "drift")) process.exit(1)
if (outcomes.some((o) => o.status === "updated"))
  console.log("\nmanifests changed: run `bun test` and update any detection tests they break")
