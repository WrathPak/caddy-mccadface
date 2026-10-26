/** The viewport camera as the Render workspace sees it (set from inside the canvas, read by render jobs). */
import type { Camera } from 'three'

export const liveView: { camera: Camera | null; invalidate: (() => void) | null } = { camera: null, invalidate: null }
