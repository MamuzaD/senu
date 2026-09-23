import { useEffect, useState } from "react"
import { Line } from "./line.tsx"
import { colors } from "./theme.ts"

const WIDTH = 40
const HEIGHT = 3
const STEPS = 36
const FRAME_MS = 110

const GLIDE = "-v-"
const FLAP = ["\\v/", GLIDE, "/v\\", GLIDE]
/** Frames per lap where she flaps; the rest of the lap she glides. */
const FLAP_START = 6

function sprite(frame: number): string {
  const inLap = frame % 18
  return inLap < FLAP.length ? FLAP[(inLap + FLAP_START) % FLAP.length]! : GLIDE
}

/** Where she sits at a step around an ellipse; y=0 is the far (top) side. */
function position(step: number) {
  const theta = (step / STEPS) * 2 * Math.PI
  const x = Math.round((WIDTH - 3) / 2 + ((WIDTH - 3) / 2 - 1) * Math.cos(theta))
  const y = Math.round((HEIGHT - 1) / 2 + ((HEIGHT - 1) / 2) * Math.sin(theta))
  return { x, y }
}

/** Senu circling overhead. She circles while `circling`, and holds a glide otherwise. */
export function Eagle({ circling }: { circling: boolean }) {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!circling) return
    const id = setInterval(() => setFrame((f) => f + 1), FRAME_MS)
    return () => clearInterval(id)
  }, [circling])

  const { x, y } = position(frame % STEPS)
  const body = circling ? sprite(frame) : GLIDE
  const fg = y === 0 ? colors.eagleFar : colors.eagle

  return (
    <box flexDirection="column" height={HEIGHT} flexShrink={0}>
      {Array.from({ length: HEIGHT }, (_, row) => (
        <Line key={row} fg={fg}>
          {row === y ? <span fg={fg}>{" ".repeat(x) + body}</span> : " "}
        </Line>
      ))}
    </box>
  )
}
