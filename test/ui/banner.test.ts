import { expect, test } from "bun:test"

import { banner } from "~/ui/banner.ts"
import { brand } from "~/ui/theme.ts"

test("text sits left of the perched bird, which starts past the longest line", () => {
  const out = banner([
    ["sound ", brand.papyrus],
    ["on", brand.gold],
  ])
  expect(Bun.stripANSI(out).split("\n")).toEqual([
    "",
    "senu       ▟▙",
    "sound on   ▐▘▙",
    "           ▝▜█▙",
    "            ▝ ▀▘",
    "",
  ])
  expect(out).toContain("\x1b[1;38;2;242;196;107msenu\x1b[0m")
  expect(out).toContain("\x1b[38;2;233;220;192;48;2;186;162;132m▘")
})

test("NO_COLOR keeps the layout without escapes", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import { banner } from "~/ui/banner.ts"; import { brand } from "~/ui/theme.ts"; process.stdout.write(banner([["hi", brand.papyrus]]))',
    ],
    { env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe" },
  )
  const out = await new Response(proc.stdout).text()
  expect(out).not.toContain("\x1b")
  expect(out.split("\n").slice(1, 3)).toEqual(["senu   ▟▙", "hi     ▐█▙"])
})
