/**
 * A rate-limit window. `left` is percent remaining; `resetsAt` is epoch seconds;
 * `windowMs` is the window's length (missing from snapshots cached before it existed).
 */
export interface Limit {
  label: string
  left: number | null
  resetsAt: number | null
  windowMs?: number | null
}

/** Codex's per-user spend cap, in dollars. */
export interface Spend {
  used: number
  limit: number
  left: number | null
  resetsAt: number | null
  reached: boolean
}

/** Codex's banked resets ("rate limit reset credits"). */
export interface Banked {
  available: number
  credits: { title: string | null; expiresAt: number | null }[]
}

export interface Snapshot {
  ok: boolean
  error: string | null
  /** Epoch seconds when this snapshot was fetched. */
  updatedAt: number
  planType: string | null
  limits: Limit[]
  spend: Spend | null
  banked: Banked | null
}

export const nowSeconds = () => Math.floor(Date.now() / 1000)

export function errorSnapshot(error: string): Snapshot {
  return {
    ok: false,
    error,
    updatedAt: nowSeconds(),
    planType: null,
    limits: [],
    spend: null,
    banked: null,
  }
}
