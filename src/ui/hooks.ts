import type { Selection } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { useEffect, useEffectEvent, useRef, useState } from "react"

export function useFlash(ms = 2000): [string, (text: string) => void] {
  const [note, setNote] = useState("")
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flash = (text: string) => {
    setNote(text)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setNote(""), ms)
  }
  return [note, flash]
}

export function usePoll(load: () => Promise<void>, ms: number): () => Promise<void> {
  const running = useRef<Promise<void> | null>(null)
  const run = () => (running.current ??= load().finally(() => (running.current = null)))
  const onTick = useEffectEvent(() => void run().catch(() => {}))
  useEffect(() => {
    const id = setInterval(onTick, ms)
    return () => clearInterval(id)
  }, [ms])
  // A call during a run waits it out and runs again, so it sees what changed since it was made
  return async () => {
    await running.current?.catch(() => {})
    return run()
  }
}

export function useSelectionDone(done: (text: string) => void): void {
  const renderer = useRenderer()
  const onSelection = useEffectEvent((selection: Selection | null) => {
    if (selection && !selection.isDragging) done(selection.getSelectedText().trim())
  })
  useEffect(() => {
    renderer.on("selection", onSelection)
    return () => void renderer.off("selection", onSelection)
  }, [renderer])
}
