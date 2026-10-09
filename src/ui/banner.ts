import { TextAttributes, type RGBA } from "@opentui/core"

import { Canvas, type Cell } from "./canvas.tsx"
import { paintSenu } from "./dive.ts"
import { brand, noColor } from "./theme.ts"

export type Span = [text: string, fg: RGBA, bold?: boolean]

const GAP = 3
const PERCHED = { width: 5, height: 4, talonsX: 1 }

const rgb = (c: RGBA) => c.toInts().slice(0, 3).join(";")

function sgr(cell: Cell | null): string {
  if (!cell || noColor) return ""
  const bold = (cell.attrs ?? 0) & TextAttributes.BOLD ? "1;" : ""
  return `${bold}38;2;${rgb(cell.fg)}${cell.bg ? `;48;2;${rgb(cell.bg)}` : ""}`
}

function ansi(c: Canvas): string {
  return c.cells
    .map((row) => {
      let out = ""
      let open = ""
      for (const cell of row.slice(0, row.findLastIndex(Boolean) + 1)) {
        if (cell?.ch === "") continue
        const style = sgr(cell)
        if (style !== open) out += (open ? "\x1b[0m" : "") + (style ? `\x1b[${style}m` : "")
        open = style
        out += cell?.ch ?? " "
      }
      return open ? `${out}\x1b[0m` : out
    })
    .join("\n")
}

export const paint = (spans: Span[]) =>
  spans
    .map(([text, fg, bold]) => {
      const style = sgr({ ch: text, fg, bg: null, attrs: bold ? TextAttributes.BOLD : 0 })
      return style ? `\x1b[${style}m${text}\x1b[0m` : text
    })
    .join("")

export function banner(message: Span[]): string {
  const lines: Span[][] = [[["senu", brand.gold, true]], message]
  const width = (line: Span[]) => Bun.stringWidth(line.map(([text]) => text).join(""))
  const birdX = Math.max(...lines.map(width)) + GAP
  const c = new Canvas(birdX + PERCHED.width, PERCHED.height)
  lines.forEach((line, y) =>
    line.reduce(
      (x, [text, fg, bold]) => c.text(x, y, text, fg, { attrs: bold ? TextAttributes.BOLD : 0 }),
      0,
    ),
  )
  const perch = { x: birdX + PERCHED.talonsX, y: PERCHED.height - 1 }
  paintSenu(c, { t: null, perch, target: perch })
  return `\n${ansi(c)}\n`
}

/** Writes text with its colours to a terminal, and without them anywhere else. */
export const write = (stream: NodeJS.WriteStream, text: string) =>
  stream.write(stream.isTTY ? text : Bun.stripANSI(text))
