/**
 * Typed values while drawing (length / angle for a line, width / height for a rectangle, diameter for a circle, chord
 * and radius for an arc). Pure helpers: which fields a tool shows, how typed numbers turn into the next point, and the
 * numbers to display for fields that are still following the cursor.
 */
import { evalNumber } from '@/doc/params'
import { dist, norm, perp, sub } from './geom'
import type { Vec2 } from './types'

export type FieldKey = 'len' | 'ang' | 'w' | 'h' | 'dia' | 'rad' | 'dist'
export type DrawTool = 'line' | 'rect' | 'rectC' | 'circle' | 'arc'

export interface TypedField { key: FieldKey; label: string; unit: 'mm' | 'deg'; text: string }
/** `tool` / `stage` identify the draft state the fields belong to (they reset when either changes). */
export interface Typed { fields: TypedField[]; active: number; tool: string; stage: number }

const F = (key: FieldKey, label: string, unit: 'mm' | 'deg'): TypedField => ({ key, label, unit, text: '' })

/** Fields a tool offers at a stage (arc: 0 = second point, 1 = third point). */
export function fieldsFor(tool: DrawTool | 'offset', stage = 0): TypedField[] {
  switch (tool) {
    case 'line': return [F('len', 'Length', 'mm'), F('ang', 'Angle', 'deg')]
    case 'rect':
    case 'rectC': return [F('w', 'Width', 'mm'), F('h', 'Height', 'mm')]
    case 'circle': return [F('dia', 'Diameter', 'mm')]
    case 'arc': return stage === 0 ? [F('len', 'Length', 'mm'), F('ang', 'Angle', 'deg')] : [F('rad', 'Radius', 'mm')]
    case 'offset': return [F('dist', 'Distance', 'mm')]
  }
}

export type Values = Partial<Record<FieldKey, number>>

/** Numeric values of the fields that hold a valid expression (user parameters allowed). */
export function valuesOf(t: Typed | null): Values {
  const v: Values = {}
  if (!t) return v
  for (const f of t.fields) {
    if (!f.text.trim()) continue
    const n = evalNumber(f.text, f.unit)
    if (n !== null) v[f.key] = n
  }
  return v
}
/** True when at least one field has text. */
export const hasText = (t: Typed | null) => !!t && t.fields.some((f) => f.text.trim() !== '')

const deg = (r: number) => (r * 180) / Math.PI

/**
 * The point the tool is about to place. `pts` are the points already placed (rect / circle: the first corner / the
 * centre; line: the last point; arc: one or two points); `cursor` is where the mouse is.
 */
export function resolveEnd(tool: DrawTool, stage: number, pts: Vec2[], cursor: Vec2, v: Values): Vec2 {
  switch (tool) {
    case 'line': return polarFrom(pts[pts.length - 1], cursor, v.len, v.ang)
    case 'rect':
    case 'rectC': {
      const a = pts[0]
      const dx = cursor[0] - a[0], dy = cursor[1] - a[1]
      const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1
      const k = tool === 'rectC' ? 0.5 : 1
      return [a[0] + (v.w !== undefined ? sx * v.w * k : dx), a[1] + (v.h !== undefined ? sy * v.h * k : dy)]
    }
    case 'circle': {
      const a = pts[0]
      const d = sub(cursor, a)
      const u = dist(cursor, a) < 1e-9 ? ([1, 0] as Vec2) : norm(d)
      const r = v.dia !== undefined ? Math.abs(v.dia) / 2 : dist(cursor, a)
      return [a[0] + u[0] * r, a[1] + u[1] * r]
    }
    case 'arc': {
      if (stage === 0 || pts.length < 2) return polarFrom(pts[0], cursor, v.len, v.ang)
      return arcThrough(pts[0], pts[1], cursor, v.rad)
    }
  }
}

function polarFrom(a: Vec2, cursor: Vec2, len?: number, angDeg?: number): Vec2 {
  const l = len !== undefined ? len : dist(cursor, a)
  const ang = angDeg !== undefined ? (angDeg * Math.PI) / 180 : Math.atan2(cursor[1] - a[1], cursor[0] - a[0])
  return [a[0] + l * Math.cos(ang), a[1] + l * Math.sin(ang)]
}

/**
 * Third point of a three-point arc from p1 to p2: the mouse position, or - when a radius is typed - the apex of the arc
 * of that radius bulging towards the mouse (the minor arc unless the mouse is beyond the circle's far side).
 */
export function arcThrough(p1: Vec2, p2: Vec2, cursor: Vec2, radius?: number): Vec2 {
  if (radius === undefined) return cursor
  const chord = dist(p1, p2)
  const r = Math.max(Math.abs(radius), chord / 2)
  const mid: Vec2 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]
  const u = norm(sub(p2, p1))
  let n = perp(u)
  if ((cursor[0] - mid[0]) * n[0] + (cursor[1] - mid[1]) * n[1] < 0) n = [-n[0], -n[1]]
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2))
  const along = (cursor[0] - mid[0]) * n[0] + (cursor[1] - mid[1]) * n[1]
  const apex = along > r ? r + h : r - h // far side of the circle when the mouse is past the centre line
  return [mid[0] + n[0] * apex, mid[1] + n[1] * apex]
}

/** Numbers to show in each field (typed ones as typed, the rest measured from the resolved end point). */
export function liveValues(tool: DrawTool, stage: number, pts: Vec2[], end: Vec2): Values {
  switch (tool) {
    case 'line': {
      const a = pts[pts.length - 1]
      return { len: dist(a, end), ang: deg(Math.atan2(end[1] - a[1], end[0] - a[0])) }
    }
    case 'rect': return { w: Math.abs(end[0] - pts[0][0]), h: Math.abs(end[1] - pts[0][1]) }
    case 'rectC': return { w: 2 * Math.abs(end[0] - pts[0][0]), h: 2 * Math.abs(end[1] - pts[0][1]) }
    case 'circle': return { dia: 2 * dist(pts[0], end) }
    case 'arc': {
      if (stage === 0 || pts.length < 2) return { len: dist(pts[0], end), ang: deg(Math.atan2(end[1] - pts[0][1], end[0] - pts[0][0])) }
      return {}
    }
  }
}

/** Normalise an angle in degrees to (-180, 180]. */
export function wrapDeg(a: number): number {
  let d = ((a + 180) % 360 + 360) % 360 - 180
  if (d === -180) d = 180
  return d
}
