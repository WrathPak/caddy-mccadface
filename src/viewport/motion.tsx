/**
 * Is the camera moving? Big meshes draw a decimated copy while it is and the full mesh once the view has rested.
 *
 * The swap is done on the objects themselves, inside the render loop and before the frame is drawn. Going through React state
 * would be a frame late: the first orbit frame would still draw the full mesh, and with a few million triangles that one frame
 * is slow enough to starve React of the time it needs to apply the change.
 */
import { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Object3D } from 'three'
import { create } from 'zustand'
import { navClock } from './navClock'

export const useMotion = create<{ moving: boolean }>(() => ({ moving: false }))

/** How long the view must be still (on the nav clock) before the full-res mesh comes back. */
export const REST_MS = 180

interface Swap { full: Object3D; lod: Object3D }
const swaps = new Set<Swap>()
let isMoving = false

function applySwap(s: Swap) {
  s.full.visible = !isMoving
  s.lod.visible = isMoving
}

/** Which of each registered pair is showing: [full, low-res] (for the e2e specs). */
export const lodState = () => [...swaps].map((s) => [s.full.visible, s.lod.visible])

/** Register a full-res / low-res pair; returns the unregister function. */
export function registerLodSwap(full: Object3D, lod: Object3D): () => void {
  const s = { full, lod }
  swaps.add(s)
  applySwap(s)
  return () => void swaps.delete(s)
}

/** Mount inside the canvas. */
export function MotionTracker() {
  const invalidate = useThree((s) => s.invalidate)
  const last = useRef<number[] | null>(null)
  const lastMove = useRef(-Infinity)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useFrame((state) => {
    const c = state.camera
    // position, orientation and zoom: the matrices are only refreshed while drawing, after this runs
    const pose = [c.position.x, c.position.y, c.position.z, c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w, c.zoom]
    const prev = last.current
    let moved = false
    if (prev) for (let i = 0; i < pose.length; i++) if (Math.abs(prev[i] - pose[i]) > 1e-9) { moved = true; break }
    last.current = pose
    const now = navClock.now()
    if (moved) lastMove.current = now
    const moving = now - lastMove.current < REST_MS
    if (moving !== isMoving) {
      isMoving = moving
      for (const s of swaps) applySwap(s)
      useMotion.setState({ moving })
    }
    if (moving) {
      // the demand loop would sleep with the low-res mesh still showing: wake it once the rest time is up
      clearTimeout(timer.current)
      timer.current = setTimeout(() => invalidate(), REST_MS + 30)
    }
  })
  return null
}
