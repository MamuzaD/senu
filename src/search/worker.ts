import { scanFile, type Found, type Job, type Spec } from "./scan.ts"

export interface Task {
  spec: Spec
  jobs: (Job & { i: number; size: number })[]
}
export type Scanned = { i: number; found: Found[] } | { i: number; error: string }

declare const self: Worker

self.addEventListener("message", (e: MessageEvent<Task>) => {
  const { spec, jobs } = e.data
  const scanned = jobs.map((job): Scanned => {
    try {
      return { i: job.i, found: scanFile(job, spec) }
    } catch (err) {
      // Codex deletes a rollout once it has compressed it
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { i: job.i, found: [] }
      return { i: job.i, error: String(err) }
    }
  })
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker, not a window
  self.postMessage(scanned)
})
