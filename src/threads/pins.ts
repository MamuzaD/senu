import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { stateDir } from "~/paths.ts"

export const pinsPath = join(stateDir, "pins.json")

/** Pinned threads by `threadKey`, in the order they were pinned */
export function readPins(path = pinsPath): string[] {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as string[]
  } catch {
    return []
  }
}

export function writePins(pins: string[], path = pinsPath) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(pins)}\n`)
  renameSync(tmp, path)
}

/** Unpins `key` if it's pinned, else pins it below the rest */
export const togglePin = (pins: string[], key: string): string[] =>
  pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key]
