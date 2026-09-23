import type { TextProps } from "@opentui/react"
import { colors } from "./theme.ts"

/**
 * One terminal row of text. It never wraps or shrinks, so a popup shorter
 * than its content clips at the bottom instead of squashing rows together.
 */
export function Line(props: TextProps) {
  return <text fg={colors.fg} wrapMode="none" flexShrink={0} {...props} />
}
