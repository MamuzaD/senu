import { closeSync, fstatSync, openSync, readSync } from "node:fs"

function wholeLines(path: string, from: "head" | "tail", bytes: number): string {
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    const length = Math.min(bytes, size)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, from === "head" ? 0 : size - length)
    const text = buf.toString("utf8")
    if (length === size) return text
    return from === "head"
      ? text.slice(0, text.lastIndexOf("\n") + 1)
      : text.slice(text.indexOf("\n") + 1)
  } finally {
    closeSync(fd)
  }
}

/** Parses JSONL, skipping blank and malformed lines (a CLI may be mid-write on the last one). */
export function records(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split("\n")) {
    if (!line) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === "object") out.push(value)
    } catch {}
  }
  return out
}

export const headRecords = (path: string, bytes: number) => records(wholeLines(path, "head", bytes))
export const tailRecords = (path: string, bytes: number) => records(wholeLines(path, "tail", bytes))

export const firstLine = (text: string) => text.trimStart().split("\n", 1)[0]!.trim()
