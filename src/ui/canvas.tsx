import type { RGBA } from "@opentui/core"

import { Line } from "./line.tsx"

export interface Cell {
  ch: string
  fg: RGBA
  bg: RGBA | null
  /** TextAttributes bits; zero means none. */
  attrs?: number
}

export class Canvas {
  readonly width: number
  readonly height: number
  readonly cells: (Cell | null)[][]

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.cells = Array.from({ length: height }, () => Array<Cell | null>(width).fill(null))
  }

  put(
    x: number,
    y: number,
    ch: string,
    fg: RGBA,
    opts: { bg?: RGBA | null; attrs?: number | undefined } = {},
  ) {
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    this.cells[y]![x] = { ch, fg, bg: opts.bg ?? null, attrs: opts.attrs ?? 0 }
  }

  /**
   * Write text from column `x`, clipped at `max` (the canvas's width by
   * default). A wide character takes two cells, the second left empty so
   * the row keeps its width. Returns the column after the text.
   */
  text(
    x: number,
    y: number,
    s: string,
    fg: RGBA,
    opts: { attrs?: number; max?: number } = {},
  ): number {
    const max = Math.min(opts.max ?? this.width, this.width)
    for (const { segment } of graphemes.segment(s)) {
      const w = Bun.stringWidth(segment)
      if (w === 0) continue
      if (x + w > max) break
      this.put(x, y, segment, fg, { attrs: opts.attrs })
      if (w === 2) this.put(x + 1, y, "", fg, { attrs: opts.attrs })
      x += w
    }
    return x
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

const same = (a: RGBA | null, b: RGBA | null) => a === b || (!!a && !!b && a.equals(b))

export function CanvasView({ canvas, from = 0 }: { canvas: Canvas; from?: number }) {
  return (
    <box flexDirection="column" height={canvas.height} flexShrink={0}>
      {canvas.cells.map((row, y) => {
        const runs: { text: string; fg: RGBA | null; bg: RGBA | null; attrs: number }[] = []
        for (const cell of row.slice(from)) {
          const fg = cell?.fg ?? null
          const bg = cell?.bg ?? null
          const attrs = cell?.attrs ?? 0
          const last = runs.at(-1)
          if (last && same(last.fg, fg) && same(last.bg, bg) && last.attrs === attrs)
            last.text += cell?.ch ?? " "
          else runs.push({ text: cell?.ch ?? " ", fg, bg, attrs })
        }
        while (runs.length && !runs.at(-1)!.fg && !runs.at(-1)!.bg) runs.pop()
        return (
          <Line key={y}>
            {runs.length === 0
              ? " "
              : runs.map((r, i) =>
                  r.fg || r.bg ? (
                    <span
                      key={i}
                      {...(r.fg ? { fg: r.fg } : {})}
                      {...(r.bg ? { bg: r.bg } : {})}
                      attributes={r.attrs}
                    >
                      {r.text}
                    </span>
                  ) : (
                    r.text
                  ),
                )}
          </Line>
        )
      })}
    </box>
  )
}

/** One pixel per column and two per terminal row; dimensions are pixel counts. */
export class Pixels {
  readonly width: number
  readonly height: number
  readonly px: (RGBA | null)[][]

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.px = Array.from({ length: height }, () => Array<RGBA | null>(width).fill(null))
  }

  set(x: number, y: number, c: RGBA | null) {
    x = Math.round(x)
    y = Math.round(y)
    if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.px[y]![x] = c
  }

  get(x: number, y: number): RGBA | null {
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? this.px[y]![x]! : null
  }
}

const BRAILLE = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

/** Braille dots at two columns and four rows per terminal cell. */
export class Braille {
  readonly cols: number
  readonly rows: number
  readonly bits: number[][]
  readonly color: (RGBA | null)[][]
  private readonly weight: number[][]

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.bits = Array.from({ length: rows }, () => Array<number>(cols).fill(0))
    this.color = Array.from({ length: rows }, () => Array<RGBA | null>(cols).fill(null))
    this.weight = Array.from({ length: rows }, () => Array<number>(cols).fill(-1))
  }

  /** When dots share a cell, the color with the highest weight wins. */
  dot(x: number, y: number, c: RGBA, weight = 0) {
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || y < 0 || x >= this.cols * 2 || y >= this.rows * 4) return
    const cx = x >> 1
    const cy = y >> 2
    this.bits[cy]![cx]! |= BRAILLE[y & 3]![x & 1]!
    if (weight >= this.weight[cy]![cx]!) {
      this.weight[cy]![cx] = weight
      this.color[cy]![cx] = c
    }
  }
}

/** Quadrant pixels at two columns and two rows per terminal cell. */
export class Quad {
  readonly cols: number
  readonly rows: number
  readonly px: (RGBA | null)[][]

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.px = Array.from({ length: rows * 2 }, () => Array<RGBA | null>(cols * 2).fill(null))
  }

  set(x: number, y: number, c: RGBA) {
    x = Math.round(x)
    y = Math.round(y)
    if (x >= 0 && y >= 0 && x < this.cols * 2 && y < this.rows * 2) this.px[y]![x] = c
  }
}
