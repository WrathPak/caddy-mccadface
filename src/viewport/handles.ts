import type { FilterFunction } from '@react-three/fiber'
import type { Object3D } from 'three'
import { touchGrab } from './touchGrab'

/**
 * On-canvas manipulator handles (extrude arrow, detail / hair handles, ...) have to win a pick over the geometry around them,
 * wherever the pointer finds them, even with a body or sketch between the camera and the handle's hit area (the arrow is drawn
 * without depth testing, so it is visible there). A handle marks its hit objects with `userData={{ handle: true }}`.
 *
 *  - `handlesOnly` is the Canvas `events.filter`: when the pointer is over a handle, the handle is the only thing that hears the
 *    event, so no body / edge / sketch under it highlights, and no handler of theirs can swallow the event first.
 *  - A press that a handle took (every handle calls `markGrab()` in its pointer-down, TransformControls does through onMouseDown)
 *    owns the whole gesture: when the button comes up the click that follows does not reach the geometry behind the handle, and
 *    it does not count as a click on empty space either (`ownedGesture`).
 */
export const isHandle = (o: Object3D | null): boolean => {
  for (let p: Object3D | null = o; p; p = p.parent) if (p.userData?.handle) return true
  return false
}

let downAt = 0
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pointerdown', () => { downAt = performance.now() }, true)
}

/** True when the button press that started the current gesture was taken by a handle. */
export const ownedGesture = () => touchGrab.stamp >= downAt && downAt > 0

const CLICKISH = new Set(['click', 'dblclick', 'contextmenu'])

export const handlesOnly: FilterFunction = (hits, state) => {
  const own = hits.filter((h) => isHandle(h.object))
  if (own.length) return own
  // a click that ends a gesture a handle owns: nothing under the pointer may take it
  const t = (state.internal.lastEvent.current as Event | null)?.type
  return t && CLICKISH.has(t) && ownedGesture() ? [] : hits
}
