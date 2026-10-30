/** Section Analysis: a live clipping plane through the bodies, shown in the viewport until it is removed. */
import { resolveParams } from '@/doc/params'
import { useDoc } from '@/doc/store'
import { bbox, type Vec3 } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { resetManip } from '@/viewport/preview'
import { showArrows } from './handleKit'

export const sectionSchema: ParamSchema = {
  id: 'section',
  title: 'Section Analysis',
  params: [
    { type: 'enum', key: 'axis', help: 'The direction the cutting plane faces: X, Y or Z. Everything on the far side of the plane is hidden.', label: 'Plane normal', display: 'segmented', default: 'Z', options: [{ value: 'X', label: 'X' }, { value: 'Y', label: 'Y' }, { value: 'Z', label: 'Z' }] },
    { type: 'number', key: 'offset', help: 'Where the plane sits along that axis, in mm.', label: 'Offset', unit: 'mm', step: 1, default: 0 },
    { type: 'bool', key: 'flip', help: 'Hide the other side of the plane instead.', label: 'Flip side', default: false },
  ],
}

/** Middle of the scene along an axis, so the first section visibly cuts the model. */
function centerOf(axis: 'X' | 'Y' | 'Z'): number {
  const k = { X: 0, Y: 1, Z: 2 }[axis]
  let lo = Infinity, hi = -Infinity
  for (const b of useDoc.getState().geometry) {
    const bb = bbox(b.mesh.positions)
    lo = Math.min(lo, bb.min[k]); hi = Math.max(hi, bb.max[k])
  }
  return Number.isFinite(lo) ? +((lo + hi) / 2).toFixed(3) : 0
}

/** The offset arrow stands on the plane through the origin, in the middle of the model, and carries the section plane with it. */
function sectionArrow(v: ParamValues, move: (offset: number) => void) {
  try {
    const p = resolveParams(sectionSchema, v)
    const k = { X: 0, Y: 1, Z: 2 }[p.axis as 'X' | 'Y' | 'Z']
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (const b of useDoc.getState().geometry) {
      const bb = bbox(b.mesh.positions)
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], bb.min[i]); hi[i] = Math.max(hi[i], bb.max[i]) }
    }
    if (!Number.isFinite(lo[0])) return resetManip()
    const origin: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
    origin[k] = 0
    const dir: Vec3 = [0, 0, 0]
    dir[k] = 1
    showArrows([{ origin, dir, key: 'offset' }], p, (patch) => move(patch.offset as number))
  } catch { resetManip() }
}

export function startSection() {
  const ui = useUi.getState()
  ui.inspector?.onCancel()
  const cur = ui.section
  const start: ParamValues = cur.on ? { axis: cur.axis, offset: cur.offset, flip: cur.flip } : { axis: 'Z', offset: centerOf('Z'), flip: false }
  const apply = (v: ParamValues) => {
    try {
      const p = resolveParams(sectionSchema, v)
      useUi.getState().setSection({ on: true, axis: p.axis as 'X' | 'Y' | 'Z', offset: p.offset as number, flip: !!p.flip })
    } catch { /* invalid expression: keep the previous plane */ }
  }
  // dragging the arrow edits the offset in the open dialog, like typing it
  const drag = (offset: number) => {
    const insp = useUi.getState().inspector
    if (!insp) return
    const next = { ...insp.values, offset }
    useUi.getState().openInspector({ ...insp, values: next })
    apply(next)
    sectionArrow(next, drag)
  }
  const close = () => {
    resetManip()
    useUi.getState().closeInspector()
    useUi.getState().setActiveTool(null)
  }
  ui.setActiveTool('inspect.section')
  ui.openInspector({
    schema: sectionSchema,
    values: start,
    onChange: (v) => {
      // moving to another axis re-centres the plane on the model
      const prev = useUi.getState().section
      const next = v.axis !== prev.axis && prev.on ? { ...v, offset: centerOf(v.axis as 'X' | 'Y' | 'Z') } : v
      apply(next)
      if (next !== v) useUi.getState().openInspector({ ...useUi.getState().inspector!, values: next })
      sectionArrow(next, drag)
    },
    onOk: close,
    onCancel: () => { useUi.getState().setSection({ on: false }); close() },
  })
  apply(start)
  sectionArrow(start, drag)
}
