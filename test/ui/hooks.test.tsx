import { afterEach, expect, test } from "bun:test"

import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "@opentui/react"
import { act } from "react"

import { usePoll } from "~/ui/hooks.ts"

let destroy: (() => void) | null = null
afterEach(() => {
  destroy?.()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false })
})

test("a poll called mid-run runs again once that run ends", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const t = await createTestRenderer({ width: 10, height: 2 })
  destroy = () => act(() => t.renderer.destroy())
  const runs: PromiseWithResolvers<void>[] = []
  const got: (() => Promise<void>)[] = []
  function Poller({ onPoll }: { onPoll: (poll: () => Promise<void>) => void }) {
    onPoll(
      usePoll(() => {
        runs.push(Promise.withResolvers())
        return runs.at(-1)!.promise
      }, 60_000),
    )
    return null
  }
  act(() => createRoot(t.renderer).render(<Poller onPoll={(p) => got.push(p)} />))
  const poll = got.at(-1)!

  const first = poll()
  await Bun.sleep(0)
  const second = poll()
  await Bun.sleep(0)
  expect(runs).toHaveLength(1)
  runs[0]!.resolve()
  await first
  await Bun.sleep(0)
  expect(runs).toHaveLength(2)
  runs[1]!.resolve()
  await second
})
