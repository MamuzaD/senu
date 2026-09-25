import { existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import { cacheDir, expandHome } from "../paths.ts"
import type { SoundKind } from "./state.ts"
import doneM4a from "./sounds/done.m4a" with { type: "file" }
import requestM4a from "./sounds/request.m4a" with { type: "file" }

/**
 * The chimes. The bundled m4a files are embedded in the binary, but `afplay`
 * can't read Bun's virtual filesystem, so they're copied to
 * `~/.cache/senu/sounds/` the first time one plays.
 */

const EMBEDDED: Record<SoundKind, string> = { done: doneM4a, request: requestM4a }
export const SYSTEM_SOUNDS: Record<SoundKind, string> = {
  done: "/System/Library/Sounds/Glass.aiff",
  request: "/System/Library/Sounds/Funk.aiff",
}
export const soundsDir = join(cacheDir, "sounds")

/** The bundled sound on real disk, extracted if it's missing or stale; null if that fails. */
export async function bundledSound(kind: SoundKind): Promise<string | null> {
  const dest = join(soundsDir, `${kind}.m4a`)
  const src = Bun.file(EMBEDDED[kind])
  try {
    if (statSync(dest).size === src.size) return dest
  } catch {}
  try {
    mkdirSync(soundsDir, { recursive: true })
    const tmp = `${dest}.${process.pid}.tmp`
    await Bun.write(tmp, src)
    renameSync(tmp, dest)
    return dest
  } catch {
    return null
  }
}

/**
 * The first that exists: the `@ai_sound_<kind>` option's path, the bundled
 * sound, the macOS system sound.
 */
export function pickSound(option: string, bundled: string | null, system: string, exists: (p: string) => boolean = existsSync): string | null {
  const opt = option.trim() ? expandHome(option.trim()) : ""
  for (const p of [opt, bundled, system]) if (p && exists(p)) return p
  return null
}

export async function resolveSound(kind: SoundKind, option: string): Promise<string | null> {
  // only extract the bundled file when the option doesn't already name a sound
  const opt = option.trim() ? expandHome(option.trim()) : ""
  if (opt && existsSync(opt)) return opt
  return pickSound("", await bundledSound(kind), SYSTEM_SOUNDS[kind])
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
