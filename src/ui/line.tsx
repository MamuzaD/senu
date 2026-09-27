import type { TextProps } from "@opentui/react"

import { colors } from "./theme.ts"

export function Line(props: TextProps) {
  return <text fg={colors.fg} wrapMode="none" flexShrink={0} {...props} />
}
