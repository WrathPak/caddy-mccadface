/** Shared drawing helpers: entity polylines, profile geometry, sketch data registry. */
import { create } from 'zustand'
import { Path, Shape, ShapeGeometry } from 'three'
import { sampleArc, loopPoly, polar, TAU, arcInfo } from './geom'
import { circleOf, pos } from './model'
import type { Entity, Profile, SketchData, SketchModel, Vec2 } from './types'

export interface Polyline { id: string; pts: Vec2[]; construction: boolean; ref: boolean }

export function entityPolylines(m: SketchModel): Polyline[] {
  const out: Polyline[] = []
  for (const e of m.entities) {
    if (e.type === 'point') continue
    out.push({ id: e.id, pts: curvePoints(m, e), construction: !!e.construction, ref: !!e.ref })
  }
  return out
}

export function curvePoints(m: SketchModel, e: Entity): Vec2[] {
  if (e.type === 'line') return [pos(m, e.p1), pos(m, e.p2)]
  if (e.type === 'circle') {
    const { c, r } = circleOf(m, e)
    const pts: Vec2[] = []
    for (let i = 0; i <= 96; i++) pts.push(polar(c, r, (i / 96) * TAU))
    return pts
  }
  if (e.type === 'arc') {
    const c = pos(m, e.c), s = pos(m, e.s), t = pos(m, e.e)
    const i = arcInfo(c, s, t)
    return [s, ...sampleArc(c, i.r, i.a0, i.a1, Math.PI / 48)]
  }
  return []
}

/** Filled region geometry (z = 0, plane-local). */
export function profileGeometry(p: Profile): ShapeGeometry {
  const toPath = (pts: Vec2[], P: Path) => {
    P.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) P.lineTo(pts[i][0], pts[i][1])
    P.closePath()
    return P
  }
  const outer = loopPoly(p.outer)
  const shape = toPath(outer, new Shape()) as Shape
  for (const h of p.holes) shape.holes.push(toPath(loopPoly(h), new Path()))
  return new ShapeGeometry(shape)
}

/** Sketch data published by Sketch features (main-thread mirror of ctx.dataOf for the viewport). */
interface Registry { data: Record<string, SketchData>; set(id: string, d: SketchData): void }
export const useSketchData = create<Registry>((set) => ({
  data: {},
  set: (id, d) => set((s) => ({ data: { ...s.data, [id]: d } })),
}))
