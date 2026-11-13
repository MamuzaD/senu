import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readPins, togglePin, writePins } from "~/threads/pins.ts"

test("a pin goes below the rest, and toggling it again takes it out", () => {
  const pins = togglePin(["claude:a"], "codex:b")
  expect(pins).toEqual(["claude:a", "codex:b"])
  expect(togglePin(pins, "claude:a")).toEqual(["codex:b"])
})

test("pins survive a write, and a missing file reads as none", () => {
  const path = join(mkdtempSync(join(tmpdir(), "senu-pins-")), "state", "pins.json")
  expect(readPins(path)).toEqual([])
  writePins(["claude:a", "codex:b"], path)
  expect(readPins(path)).toEqual(["claude:a", "codex:b"])
})
