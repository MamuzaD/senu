import { Canvas, CanvasView } from "./canvas.tsx"
import { SCENE_COLS, SCENE_ROWS } from "./desert.ts"
import { paintSky, type FlightPlan } from "./senu.ts"

/**
 * The night desert with Senu in it, as the popup's header. In a terminal
 * narrower than the scene it gives up columns on the left, so the moon and
 * the snag she perches on stay in view.
 */
export function Sky({ plan, width }: { plan: FlightPlan; width: number }) {
  const canvas = new Canvas(SCENE_COLS, SCENE_ROWS)
  paintSky(canvas, plan)
  return <CanvasView canvas={canvas} from={Math.max(0, SCENE_COLS - width)} />
}
