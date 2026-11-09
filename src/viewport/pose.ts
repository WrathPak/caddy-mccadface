/**
 * The camera as plain numbers, shared between the viewport (which reports it every frame it moves) and everything that wants it
 * without three.js: the phone / desktop layout swap puts the view back, and the session snapshot keeps it so a reload comes back
 * to the same view.
 */
export interface PoseData { target: [number, number, number]; q: [number, number, number, number]; dist: number }

let current: PoseData | null = null
let viewReady: () => void = () => {}
/** Resolves when the viewport has drawn its first frame, or after a few seconds if there is none (so nothing waits for ever). */
export const viewportReady: Promise<void> = new Promise((res) => { viewReady = res; setTimeout(res, 4000) })
const watchers = new Set<() => void>()

/** The view right now, or the one waiting for the viewport to mount; null before any viewport existed. */
export const getPoseData = (): PoseData | null => current

/** Start the viewport on this view instead of the home view. Used before it mounts, so the first frame is already right. */
export function setPoseData(p: PoseData | null) {
  current = p ? { target: [...p.target], q: [...p.q], dist: p.dist } : null
}

/** Called after a frame; tells the watchers only when the camera is not where it was. */
export function reportPose(target: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }, dist: number) {
  viewReady()
  const c = current
  if (c && c.target[0] === target.x && c.target[1] === target.y && c.target[2] === target.z && c.q[0] === q.x && c.q[1] === q.y && c.q[2] === q.z && c.q[3] === q.w && c.dist === dist) return
  current = { target: [target.x, target.y, target.z], q: [q.x, q.y, q.z, q.w], dist }
  if (c) watchers.forEach((f) => f()) // (the first report is the view the page opened with, nothing to keep yet)
}

/** Returns the stop function. */
export function watchPose(fn: () => void) {
  watchers.add(fn)
  return () => { watchers.delete(fn) }
}

/** The same view within a hair: used to tell a camera that came back from one that was reframed. */
export const samePose = (a: PoseData, b: PoseData, eps = 1e-6) =>
  Math.abs(a.dist - b.dist) <= eps * Math.max(1, a.dist) && a.target.every((v, i) => Math.abs(v - b.target[i]) <= eps * Math.max(1, a.dist)) && a.q.every((v, i) => Math.abs(v - b.q[i]) <= eps)
