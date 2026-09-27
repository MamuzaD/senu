import type { RGBA } from "@opentui/core"

import { colors } from "~/ui/theme.ts"

import { nowSeconds } from "./types.ts"

export const BAR_WIDTH = 24
export const LABEL_WIDTH = 8

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600) % 24
  const days = Math.floor(total / 86400)
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
  return `${minutes}m`
}

export const formatUntil = (epochSeconds: number | null) =>
  epochSeconds == null ? null : formatDuration(epochSeconds - nowSeconds())

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Local 24-hour reset clock, rounded to a minute: HH:MM today, weekday and time within six days, then day and month. */
export function formatClock(epochSeconds: number | null, now = new Date()): string | null {
  if (epochSeconds == null) return null
  const at = new Date(Math.round(epochSeconds / 60) * 60_000)
  const days = Math.round(
    (new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86_400_000,
  )
  if (days < 0) return null
  const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  if (days === 0) return hm
  if (days < 7) return `${WEEKDAYS[at.getDay()]} ${hm}`
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`
}

export const clockSuffix = (clock: string) => ` · ${clock}`

export function colorFor(left: number | null): RGBA {
  if (left == null) return colors.dim
  if (left < 20) return colors.bad
  if (left < 40) return colors.warn
  return colors.good
}

/** Remaining-window percentage at an even spending pace; null when reset or window length is unavailable or past. */
export function evenLeft(
  resetsAt: number | null,
  windowMs: number | null | undefined,
): number | null {
  if (resetsAt == null || !windowMs) return null
  const remaining = resetsAt - nowSeconds()
  if (remaining <= 0) return null
  return Math.min(100, (remaining * 1000 * 100) / windowMs)
}

export const PACE_SLACK = 5

export const markCell = (even: number) =>
  Math.min(BAR_WIDTH - 1, Math.floor((even * BAR_WIDTH) / 100))

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]

export function bar(left: number | null): string {
  if (left == null) return "░".repeat(BAR_WIDTH)
  const eighths = Math.round((Math.max(0, Math.min(100, left)) * BAR_WIDTH * 8) / 100)
  const full = Math.floor(eighths / 8)
  const edge = EIGHTHS[eighths % 8]!
  return "█".repeat(full) + edge + "░".repeat(BAR_WIDTH - full - (edge ? 1 : 0))
}

const short = (v: number, unit: string) =>
  `${v < 9.95 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)}${unit}`

export function formatTokens(n: number): string {
  if (n >= 999_500_000) return short(n / 1e9, "B")
  if (n >= 999_500) return short(n / 1e6, "M")
  if (n >= 1000) return short(n / 1e3, "k")
  return String(n)
}
