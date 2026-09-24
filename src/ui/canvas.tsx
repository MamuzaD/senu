import type { RGBA } from "@opentui/core"
import { Line } from "./line.tsx"

/**
 * The pixel layer under the popup's scene: a character grid to paint into,
 * a half-block pixel buffer, braille dots and quadrant pixels. Nothing
 * paints a background unless it's asked to, so the terminal (and its blur)
 * shows through everywhere the scene is empty.
 */
export interface Cell {
  ch: string
  fg: RGBA
  bg: RGBA | null
}

export class Canvas {
  readonly cells: (Cell | null)[][]

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = Array.from({ length: height }, () => Array<Cell | null>(width).fill(null))
  }

  put(x: number, y: number, ch: string, fg: RGBA, opts: { bg?: RGBA | null } = {}) {
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    this.cells[y]![x] = { ch, fg, bg: opts.bg ?? null }
  }
}

const same = (a: RGBA | null, b: RGBA | null) => a === b || (!!a && !!b && a.equals(b))

/** Render a canvas as `Line`s from column `from`, one span per run of the same colours. */
export function CanvasView({ canvas, from = 0 }: { canvas: Canvas; from?: number }) {
  return (
    <box flexDirection="column" height={canvas.height} flexShrink={0}>
      {canvas.cells.map((row, y) => {
        const runs: { text: string; fg: RGBA | null; bg: RGBA | null }[] = []
        for (const cell of row.slice(from)) {
          const fg = cell?.fg ?? null
          const bg = cell?.bg ?? null
          const last = runs.at(-1)
          if (last && same(last.fg, fg) && same(last.bg, bg)) last.text += cell?.ch ?? " "
          else runs.push({ text: cell?.ch ?? " ", fg, bg })
        }
        while (runs.length && !runs.at(-1)!.fg && !runs.at(-1)!.bg) runs.pop()
        return (
          <Line key={y}>
            {runs.length === 0
              ? " "
              : runs.map((r, i) =>
                  r.fg || r.bg ? (
                    <span key={i} fg={r.fg ?? undefined} bg={r.bg ?? undefined}>
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

/** A pixel buffer twice as tall as its cell area: one pixel per column, two per row. */
export class Pixels {
  readonly px: (RGBA | null)[][]

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
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

/** Braille dots: a 2×4 grid per cell. `weight` decides which colour wins a shared cell. */
export class Braille {
  readonly bits: number[][]
  readonly color: (RGBA | null)[][]
  private readonly weight: number[][]

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.bits = Array.from({ length: rows }, () => Array<number>(cols).fill(0))
    this.color = Array.from({ length: rows }, () => Array<RGBA | null>(cols).fill(null))
    this.weight = Array.from({ length: rows }, () => Array<number>(cols).fill(-1))
  }

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

/** Quadrant pixels: 2×2 per cell. Senu's body is drawn in these, so she's solid over any scene. */
export class Quad {
  readonly px: (RGBA | null)[][]

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.px = Array.from({ length: rows * 2 }, () => Array<RGBA | null>(cols * 2).fill(null))
  }

  set(x: number, y: number, c: RGBA) {
    x = Math.round(x)
    y = Math.round(y)
    if (x >= 0 && y >= 0 && x < this.cols * 2 && y < this.rows * 2) this.px[y]![x] = c
  }
}
