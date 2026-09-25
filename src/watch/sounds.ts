import { existsSync } from "node:fs"
import { expandHome } from "../paths.ts"
import type { SoundKind } from "./state.ts"

export const SYSTEM_SOUNDS: Record<SoundKind, string> = {
  done: "/System/Library/Sounds/Glass.aiff",
  request: "/System/Library/Sounds/Funk.aiff",
}

/** A configured sound file, or the macOS system sound when none is available. */
export function pickSound(custom: string, system: string, exists: (p: string) => boolean = existsSync): string | null {
  const path = custom.trim() ? expandHome(custom.trim()) : ""
  for (const p of [path, system]) if (p && exists(p)) return p
  return null
}

export function resolveSound(kind: SoundKind, custom: string): string | null {
  return pickSound(custom, process.platform === "darwin" ? SYSTEM_SOUNDS[kind] : "")
}

/** Starts `afplay` and returns at once; the poll loop never waits on audio. */
export function play(path: string): Bun.Subprocess | null {
  try {
    const proc = Bun.spawn(["afplay", path], { stdio: ["ignore", "ignore", "ignore"] })
    proc.unref()
    return proc
  } catch {
    return null // no afplay (not macOS)
  }
}
