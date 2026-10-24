/** Which snaps and inferences the sketcher offers while drawing; remembered between sessions. */
import { create } from 'zustand'

export interface SnapFlags {
  /** end points, centres, mid points, quadrants, intersections and points on curves */
  coincident: boolean
  parallel: boolean
  perpendicular: boolean
  /** extension of an existing line */
  collinear: boolean
  horizontalVertical: boolean
  tangent: boolean
  /** dotted lines from other points */
  tracking: boolean
  /** same length as another line */
  equal: boolean
  /** lock the angle to steps of 15 degrees */
  angle15: boolean
  grid: boolean
}

export const SNAP_LABELS: { key: keyof SnapFlags; label: string; help: string }[] = [
  { key: 'coincident', label: 'Points and curves', help: 'End points, centres, mid points, quadrants, intersections and points on a curve.' },
  { key: 'parallel', label: 'Parallel', help: 'Draw parallel to a nearby line (hover it first to wake it up).' },
  { key: 'perpendicular', label: 'Perpendicular', help: 'Draw at right angles to a nearby line.' },
  { key: 'collinear', label: 'Extension', help: 'Continue along the line of an existing line.' },
  { key: 'horizontalVertical', label: 'Horizontal / vertical', help: 'Lock to the sketch axes.' },
  { key: 'tangent', label: 'Tangent', help: 'Leave an arc end tangent, or touch a circle or arc tangentially.' },
  { key: 'tracking', label: 'Alignment', help: 'Dotted tracking lines from other points.' },
  { key: 'equal', label: 'Equal length', help: 'Match the length of another line.' },
  { key: 'angle15', label: 'Angle steps of 15 degrees', help: 'Snap the direction to multiples of 15 degrees.' },
  { key: 'grid', label: 'Grid', help: 'Snap to the grid.' },
]

const KEY = 'caddy-snaps-v1'
const DEFAULTS: SnapFlags = {
  coincident: true, parallel: true, perpendicular: true, collinear: true, horizontalVertical: true,
  tangent: true, tracking: true, equal: true, angle15: false, grid: true,
}

function load(): SnapFlags {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch { /* storage unavailable */ }
  return { ...DEFAULTS }
}

export const useSnapFlags = create<{ flags: SnapFlags; set(k: keyof SnapFlags, on: boolean): void; reset(): void }>((set, get) => ({
  flags: load(),
  set: (k, on) => {
    const flags = { ...get().flags, [k]: on }
    set({ flags })
    try { localStorage.setItem(KEY, JSON.stringify(flags)) } catch { /* storage unavailable */ }
  },
  reset: () => {
    set({ flags: { ...DEFAULTS } })
    try { localStorage.removeItem(KEY) } catch { /* storage unavailable */ }
  },
}))
export const defaultSnapFlags = DEFAULTS
