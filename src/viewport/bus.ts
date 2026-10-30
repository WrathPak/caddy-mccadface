/** Tiny typed event bus so commands (outside React Three Fiber) can drive the viewport. */
export type ViewDir = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'home'
/** ViewCube arrows: 90 degree turns about the screen axes and rolls about the view axis */
export type StepKind = 'left' | 'right' | 'up' | 'down' | 'rollCW' | 'rollCCW'

export interface ViewportEvents {
  frame: undefined
  /** fit the view to a world-space box (View > Frame Selection) */
  frameBox: { min: [number, number, number]; max: [number, number, number] }
  view: ViewDir
  /** back to the view a fresh page opens with: home direction, default distance, centred on the origin (a new document) */
  resetView: undefined
  /** snap to an arbitrary view direction (unit vector from target toward camera) */
  viewVec: [number, number, number]
  /**
   * a tool is about to work on a plane with this normal: when the view looks straight at that plane (within `within` degrees, from
   * either side), tilt it about the screen axes by about `deg` towards the home view so depth shows. Any other view stays as it is.
   */
  tiltFromFacing: { normal: [number, number, number]; within?: number; deg?: number }
  /** turn the view one 90 degree step (relative to the current / pending view) */
  step: StepKind
  /** drag-orbit by a pointer delta in pixels (the ViewCube drag) */
  orbit: { dx: number; dy: number }
  /** request a render (frameloop is on demand) */
  redraw: undefined
}

type Handler<K extends keyof ViewportEvents> = (payload: ViewportEvents[K]) => void
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlers: Record<string, Set<(p: any) => void>> = {}

export const viewportBus = {
  on<K extends keyof ViewportEvents>(k: K, h: Handler<K>) {
    ;(handlers[k] ??= new Set()).add(h)
    return () => {
      handlers[k]?.delete(h)
    }
  },
  emit<K extends keyof ViewportEvents>(k: K, payload: ViewportEvents[K]) {
    handlers[k]?.forEach((h) => h(payload))
  },
}
