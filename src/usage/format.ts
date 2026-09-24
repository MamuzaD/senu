import type { RGBA } from "@opentui/core"
import { colors } from "../ui/theme.ts"
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

/** Colour by percent left: green at 40+, yellow 20–39, red under 20, grey when unknown. */
export function colorFor(left: number | null): RGBA {
  if (left == null) return colors.dim
  if (left < 20) return colors.bad
  if (left < 40) return colors.warn
  return colors.good
}

/**
 * Where even spending would leave the bar: the percent of the window still to
 * run. Null when the window's length or reset is unknown, or it has already reset.
 */
export function evenLeft(resetsAt: number | null, windowMs: number | null | undefined): number | null {
  if (resetsAt == null || !windowMs) return null
  const remaining = resetsAt - nowSeconds()
  if (remaining <= 0) return null
  return Math.min(100, (remaining * 1000 * 100) / windowMs)
}

/** More than this many points below even means it's being used faster than time passes. */
export const PACE_SLACK = 5

/** The bar cell that holds the even-pace marker. */
export const markCell = (even: number) => Math.min(BAR_WIDTH - 1, Math.floor((even * BAR_WIDTH) / 100))

const EIGHTHS =["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]

/** A bar of percent left, with an eighth-block on the fill edge for sub-cell precision. */
export function bar(left: number | null): string {
  if (left == null) return "░".repeat(BAR_WIDTH)
  const eighths = Math.round((Math.max(0, Math.min(100, left)) * BAR_WIDTH * 8) / 100)
  const full = Math.floor(eighths / 8)
  const edge = EIGHTHS[eighths % 8]!
  return "█".repeat(full) + edge + "░".repeat(BAR_WIDTH - full - (edge ? 1 : 0))
}
