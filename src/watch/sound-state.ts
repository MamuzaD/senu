import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { stateDir } from "../paths.ts"

export const soundStatePath = join(stateDir, "sound-enabled")

export function soundOverride(path = soundStatePath): boolean | null {
  try {
    const value = readFileSync(path, "utf8").trim()
    return value === "on" ? true : value === "off" ? false : null
  } catch {
    return null
  }
}

export function effectiveSoundEnabled(defaultEnabled: boolean, path = soundStatePath): boolean {
  return soundOverride(path) ?? defaultEnabled
}

export function setSoundEnabled(enabled: boolean, path = soundStatePath) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, enabled ? "on\n" : "off\n")
  renameSync(tmp, path)
}

export function clearSoundOverride(path = soundStatePath) {
  try {
    unlinkSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}
