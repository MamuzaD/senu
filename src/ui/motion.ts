import { useEffect, useState } from "react"

export const reducedMotion = !!process.env.SENU_REDUCED_MOTION && process.env.SENU_REDUCED_MOTION !== "0"

export const FPS = 30

export const now = () => performance.now()

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
export const phase = (t: number, from: number | null, ms: number) => (from == null ? 0 : clamp((t - from) / ms))
export const pulse = (t: number, from: number | null, ms: number) =>
  from == null || t < from || t > from + ms ? 0 : Math.sin((Math.PI * (t - from)) / ms)

/** Times are ms on the now() clock; a null start or reduced motion returns the completed value, 1. */
export function tween(start: number | null, duration: number, ease: (k: number) => number = (k) => k, t = now()) {
  if (start == null || reducedMotion) return 1
  return ease(clamp((t - start) / duration))
}

export const running = (start: number | null, duration: number, t = now()) =>
  !reducedMotion && start != null && t < start + duration
