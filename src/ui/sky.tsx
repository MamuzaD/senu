import { Canvas, CanvasView } from "./canvas.tsx"
import { SCENE_COLS, SCENE_ROWS } from "./desert.ts"
import { paintSky, type FlightPlan } from "./senu.ts"

/**
 * The desert with Senu in it, as the popup's header, `plan.cols` wide. In a
 * terminal narrower than 72 columns it gives up columns on the left, so the
 * moon and the snag she perches on stay in view.
 */
export function Sky({ plan, width }: { plan: FlightPlan; width: number }) {
  const canvas = new Canvas(plan.cols, SCENE_ROWS)
  paintSky(canvas, plan)
  return <CanvasView canvas={canvas} from={Math.max(0, SCENE_COLS - width)} />
}
