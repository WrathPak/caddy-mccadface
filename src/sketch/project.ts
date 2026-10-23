/** Adding projected B-rep edges to a sketch as fixed reference geometry. */
import { dist } from './geom'
import { addArc, addCircle, addLine, addPoint, entityById, pos } from './model'
import type { ProjectedCurve } from '@/kernel/sketch-ops'
import type { Entity, SketchModel, Vec2 } from './types'

const same = (a: Vec2, b: Vec2, tol = 1e-5) => dist(a, b) <= tol

function exists(m: SketchModel, c: ProjectedCurve): boolean {
  const near = (a: Vec2, b: Vec2) => same(a, b)
  return m.entities.some((e: Entity) => {
    if (c.k === 'l' && e.type === 'line') {
      const a = pos(m, e.p1), b = pos(m, e.p2)
      return (near(a, c.a) && near(b, c.b)) || (near(a, c.b) && near(b, c.a))
    }
    if (c.k === 'c' && e.type === 'circle') return near(pos(m, e.c), c.c) && Math.abs(e.r - c.r) < 1e-5
    if (c.k === 'a' && e.type === 'arc') return near(pos(m, e.c), c.c) && near(pos(m, e.s), c.s) && near(pos(m, e.e), c.e)
    return false
  })
}

/** Appends the curves as reference entities (fixed, not draggable). Returns how many were added (duplicates are skipped). */
export function addProjected(m: SketchModel, curves: ProjectedCurve[]): number {
  let n = 0
  const pt = (p: Vec2) => {
    const id = addPoint(m, p[0], p[1])
    ;(entityById(m, id) as { ref?: boolean }).ref = true
    return id
  }
  for (const c of curves) {
    if (exists(m, c)) continue
    if (c.k === 'l') addLine(m, pt(c.a), pt(c.b)).ref = true
    else if (c.k === 'c') addCircle(m, pt(c.c), c.r).ref = true
    else addArc(m, pt(c.c), pt(c.s), pt(c.e)).ref = true
    n++
  }
  return n
}
