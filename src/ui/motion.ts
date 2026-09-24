import { useEffect, useState } from "react"

/** SENU_REDUCED_MOTION=1: nothing animates, everything renders in its settled state. */
export const reducedMotion = !!process.env.SENU_REDUCED_MOTION && process.env.SENU_REDUCED_MOTION !== "0"

/** The frame-rate ceiling for every animation. */
export const FPS = 30

/** Milliseconds on one clock shared by every component. */
export const now = () => performance.now()

/**
 * Re-render at `fps` while it's above zero; at zero no timer exists at all,
 * which is how an idle popup draws nothing. Read the time with `now()` during
 * render, so an animation that starts between ticks is still drawn right.
 */
export function useTicker(fps: number): void {
  const [, setFrame] = useState(0)
  const rate = reducedMotion ? 0 : Math.min(fps, FPS)
  useEffect(() => {
    if (rate <= 0) return
    const id = setInterval(() => setFrame((f) => f + 1), 1000 / rate)
    return () => clearInterval(id)
  }, [rate])
}

export const clamp = (k: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, k))
export const easeOut = (k: number) => 1 - (1 - clamp(k)) ** 3
export const easeInOut = (k: number) => {
  k = clamp(k)
  return k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2
}
export const smooth = (k: number) => {
  k = clamp(k)
  return k * k * (3 - 2 * k)
}
/** 0..1 through a window that opens at `from` and lasts `ms`. */
export const phase = (t: number, from: number | null, ms: number) => (from == null ? 0 : clamp((t - from) / ms))
/** A pulse that rises and falls once over `ms` after `from`. */
export const pulse = (t: number, from: number | null, ms: number) =>
  from == null || t < from || t > from + ms ? 0 : Math.sin((Math.PI * (t - from)) / ms)

/**
 * How far along a tween that starts at `start` and lasts `duration` is, from
 * 0 to 1. With no start, or with reduced motion, it's already finished.
 */
export function tween(start: number | null, duration: number, ease: (k: number) => number = (k) => k, t = now()) {
  if (start == null || reducedMotion) return 1
  return ease(clamp((t - start) / duration))
}

/** Is a tween that starts at `start` still running? */
export const running = (start: number | null, duration: number, t = now()) =>
  !reducedMotion && start != null && t < start + duration
