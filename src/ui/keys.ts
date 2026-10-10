import { type Binding } from "@opentui/keymap"
import { useActiveKeys } from "@opentui/keymap/react"

export type HintBinding = Binding & { desc?: string }

export interface Hint {
  command: string
  desc: string
}

export function useHints(): Hint[] {
  return useActiveKeys({ includeMetadata: true }).flatMap((key) =>
    typeof key.command === "string" && typeof key.bindingAttrs?.desc === "string"
      ? [{ command: key.command, desc: key.bindingAttrs.desc }]
      : [],
  )
}

export function fitHints(hints: Hint[], room: number, keep: string[]): string {
  const all = hints.map((h) => h.desc).join(" · ")
  if (Bun.stringWidth(all) <= room) return all
  return hints
    .filter((h) => keep.includes(h.command))
    .map((h) => h.desc)
    .join(" · ")
}
