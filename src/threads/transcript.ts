import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs"

function wholeLines(path: string, from: "head" | "tail", bytes: number) {
  // Codex keeps the plain path in its index after compression. Prefer it even when given
  // a .zst path: resuming a compressed session can materialize a newer plain sibling.
  const plain = path.endsWith(".jsonl.zst") ? path.slice(0, -4) : path
  let fd: number
  try {
    fd = openSync(plain, "r")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const buf = Bun.zstdDecompressSync(readFileSync(`${plain}.zst`))
    const length = Math.min(bytes, buf.length)
    return windowLines(
      from === "head" ? buf.subarray(0, length) : buf.subarray(buf.length - length),
      from,
      buf.length > bytes,
    )
  }
  try {
    const size = fstatSync(fd).size
    const length = Math.min(bytes, size)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, from === "head" ? 0 : size - length)
    return windowLines(buf, from, size > bytes)
  } finally {
    closeSync(fd)
  }
}

function windowLines(buf: Buffer, from: "head" | "tail", more: boolean) {
  const text = buf.toString("utf8")
  return {
    text: !more
      ? text
      : from === "head"
        ? text.slice(0, text.lastIndexOf("\n") + 1)
        : text.slice(text.indexOf("\n") + 1),
    more,
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

export const headRecords = (path: string, bytes: number) =>
  records(wholeLines(path, "head", bytes).text)

/** The byte window and `more` both refer to uncompressed transcript bytes. */
export function readTailRecords(path: string, bytes: number) {
  const { text, more } = wholeLines(path, "tail", bytes)
  return { records: records(text), more }
}

export const tailRecords = (path: string, bytes: number) => readTailRecords(path, bytes).records

export const firstLine = (text: string) => text.trimStart().split("\n", 1)[0]!.trim()
