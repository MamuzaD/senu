/**
 * Translates the Rust `regex` crate syntax herdr's manifests are written in to
 * JavaScript. Always compiles with the `u` flag, so `\u{HHHH}` and `\p{…}` work
 * and a pattern that means something different in JS fails loudly instead.
 *
 * What changes:
 * - `\x{HHHH}` becomes `\u{HHHH}`; `\pL` becomes `\p{L}`.
 * - `\A` and `\z` (start and end of text) become lookarounds.
 * - Leading `(?i)` and `(?s)` become JS flags. `(?m)` instead rewrites `^` and
 *   `$` to lookarounds on `\n`: JS's `m` also breaks lines at `\r`, U+2028 and
 *   U+2029, Rust's only at `\n`.
 * - `.` becomes `[^\n]` without `(?s)`: Rust's dot only stops at `\n`, JS's
 *   also stops at `\r`, U+2028 and U+2029.
 * - `\d`, `\s`, `\w` and `\b` (and their negations) become Unicode property
 *   classes: Rust's are Unicode by default, JS's `\w`/`\b` are ASCII and its
 *   `\s` also matches U+FEFF.
 * - `(?P<name>` becomes `(?<name>`.
 * - Escaped punctuation JS rejects under `u` (`\#`, `\&`, `\~`, `\-` outside a
 *   class) becomes the literal character.
 *
 * Nested classes, class set operations, mid-pattern flag groups, other flags,
 * lookaround and backreferences throw (the last two aren't Rust syntax, so herdr
 * rejects them too), so such a manifest is rejected rather than silently misread.
 */

const FLAG_GROUP = /^\(\?([a-zA-Z]+)\)/

/** Rust's Unicode `\w`, as class members. */
const WORD = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}"
const WORD_EDGE = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`
const NOT_WORD_EDGE = `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`

/** Characters JS accepts after a backslash under the `u` flag, outside a class. */
const JS_SYNTAX = new Set("^$\\.*+?()[]{}|/")

export interface TranslatedRegex {
  source: string
  flags: string
}

export function translateRustRegex(pattern: string): TranslatedRegex {
  let rest = pattern
  const flags = new Set<string>()
  for (let m = FLAG_GROUP.exec(rest); m; m = FLAG_GROUP.exec(rest)) {
    for (const f of m[1]!) {
      if (f !== "i" && f !== "m" && f !== "s")
        throw new Error(`unsupported regex flag "${f}" in ${JSON.stringify(pattern)}`)
      flags.add(f)
    }
    rest = rest.slice(m[0].length)
  }
  const dotAll = flags.has("s")
  const multiline = flags.has("m")

  let out = ""
  let inClass = false
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!

    if (c === "\\") {
      const n = rest[i + 1]
      if (n === undefined) throw new Error(`trailing backslash in ${JSON.stringify(pattern)}`)
      i++
      if (n === "x" && rest[i + 1] === "{") {
        const end = rest.indexOf("}", i)
        if (end < 0) throw new Error(`unterminated \\x{ in ${JSON.stringify(pattern)}`)
        out += `\\u{${rest.slice(i + 2, end)}}`
        i = end
      } else if ((n === "p" || n === "P") && rest[i + 1] !== "{") {
        out += `\\${n}{${rest[i + 1] ?? ""}}`
        i++
      } else if (n === "A" && !inClass) {
        out += "(?<![\\s\\S])"
      } else if (n === "z" && !inClass) {
        out += "(?![\\s\\S])"
      } else if (n === "d") {
        out += "\\p{Nd}"
      } else if (n === "D") {
        out += "\\P{Nd}"
      } else if (n === "s") {
        out += "\\p{White_Space}"
      } else if (n === "S") {
        out += "\\P{White_Space}"
      } else if (n === "w") {
        out += inClass ? WORD : `[${WORD}]`
      } else if (n === "W" || n === "b" || n === "B") {
        if (inClass)
          throw new Error(
            `"\\${n}" inside a character class is not supported: ${JSON.stringify(pattern)}`,
          )
        out += n === "W" ? `[^${WORD}]` : n === "b" ? WORD_EDGE : NOT_WORD_EDGE
      } else if (/[0-9<>]/.test(n)) {
        // backreferences aren't Rust syntax; Rust's `\<` / `\>` word edges have no JS spelling
        throw new Error(`unsupported escape "\\${n}" in ${JSON.stringify(pattern)}`)
      } else if (/[a-zA-Z]/.test(n) || JS_SYNTAX.has(n) || (inClass && n === "-")) {
        out += `\\${n}`
      } else {
        // Rust lets any punctuation be escaped; JS under `u` only accepts syntax characters.
        out += n
      }
      continue
    }

    if (inClass) {
      if (c === "]") inClass = false
      else if (c === "[")
        throw new Error(`nested character classes are not supported: ${JSON.stringify(pattern)}`)
      else if ((c === "&" || c === "~" || c === "-") && rest[i + 1] === c) {
        throw new Error(
          `character class set operations are not supported: ${JSON.stringify(pattern)}`,
        )
      }
      out += c
      continue
    }

    if (c === "[") {
      inClass = true
      out += c
      // a `]` right after `[` or `[^` is a literal in Rust
      if (rest[i + 1] === "^") out += rest[++i]
      if (rest[i + 1] === "]") {
        out += "\\]"
        i++
      }
      continue
    }

    if (c === "(" && rest[i + 1] === "?") {
      if (rest.startsWith("(?P<", i)) {
        out += "(?<"
        i += 3
        continue
      }
      const kind = rest[i + 2]
      const named = kind === "<" && rest[i + 3] !== "=" && rest[i + 3] !== "!"
      if (kind !== ":" && !named) {
        // lookaround isn't Rust syntax at all; mid-pattern flags have no JS spelling here
        throw new Error(`unsupported group "(?${kind ?? ""}" in ${JSON.stringify(pattern)}`)
      }
    }

    if (c === "." && !dotAll) out += "[^\\n]"
    else if (c === "^" && multiline) out += "(?<![^\\n])"
    else if (c === "$" && multiline) out += "(?![^\\n])"
    else out += c
  }

  // `(?m)` is spelled out above: JS's `m` would also break lines at \r, U+2028 and U+2029
  flags.delete("m")
  return { source: out, flags: [...flags, "u"].sort().join("") }
}

export function compileRustRegex(pattern: string): RegExp {
  const { source, flags } = translateRustRegex(pattern)
  return new RegExp(source, flags)
}
