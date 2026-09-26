import { Canvas, CanvasView } from "./canvas.tsx"
import { SCENE_COLS, SCENE_ROWS } from "./desert.ts"
import { paintSky, type FlightPlan } from "./senu.ts"

export function Sky({ plan, width }: { plan: FlightPlan; width: number }) {
  const canvas = new Canvas(plan.cols, SCENE_ROWS)
  paintSky(canvas, plan)
  // Crop the left edge on narrow terminals to keep the perch visible on the right.
  return <CanvasView canvas={canvas} from={Math.max(0, SCENE_COLS - width)} />
}
