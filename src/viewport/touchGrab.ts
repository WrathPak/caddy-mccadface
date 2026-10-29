/**
 * Shared facts about the fingers on the viewport, so the camera, the sketcher and the handles do not fight over a touch.
 *
 *  - `touchCount()`: how many fingers are down right now (a second finger turns any one-finger job into a camera gesture).
 *  - `markGrab()`: a handle (extrude arrow, move gizmo, hair direction...) took the finger that just went down: it is not an orbit.
 *  - `fingerOwners`: tools for which one finger is the tool's (sketching, painting, dragging a component): the camera then needs two.
 */
const down = new Set<number>()

if (typeof window !== 'undefined') {
  const add = (e: PointerEvent) => { if (e.pointerType === 'touch') down.add(e.pointerId) }
  const del = (e: PointerEvent) => { if (e.pointerType === 'touch') down.delete(e.pointerId) }
  window.addEventListener('pointerdown', add, true)
  window.addEventListener('pointerup', del, true)
  window.addEventListener('pointercancel', del, true)
  // a finger that left the page (lost focus, system gesture) must not stay counted
  window.addEventListener('blur', () => down.clear())
}

export const touchCount = () => down.size

export const touchGrab = { stamp: 0 }
/** Call from a handle's pointer-down: the finger that is down now belongs to the handle. */
export const markGrab = () => { touchGrab.stamp = performance.now() }

const owners = new Set<() => boolean>()
/** Register a predicate that is true while one finger belongs to a tool. Returns the unregister function. */
export function registerFingerOwner(fn: () => boolean) {
  owners.add(fn)
  return () => { owners.delete(fn) }
}
export const fingerOwned = () => { for (const f of owners) if (f()) return true; return false }

/** Pixels a finger may wander and still be a tap (or a press). */
export const TAP_SLOP = 10
/** Longest touch that counts as a tap, and shortest one that is a long press (ms, real time). */
export const TAP_MS = 380
export const LONG_PRESS_MS = 480
