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
  const busy = useRef(false)
  const run = async () => {
    if (busy.current) return
    busy.current = true
    try {
      await load()
    } finally {
      busy.current = false
    }
  }
  const onTick = useEffectEvent(() => void run().catch(() => {}))
  useEffect(() => {
    const id = setInterval(onTick, ms)
    return () => clearInterval(id)
  }, [ms])
  return run
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
