/** Dimension measurement and layout (witness / dimension lines, arrows, label anchor). */
import { evalNumber } from '@/doc/params'
import { add, closestOnLine, cross, dist, dot, intersectLineLine, len, mid, norm, perp, polar, sub } from './geom'
import { circleOf, entityById, lineEnds, pos } from './model'
import { isDim, type Constraint, type SketchModel, type Vec2 } from './types'

export interface Measured { value: number; sgn: 1 | -1 }

/** Direction vector measured by a single-line / two-point angle dimension. */
export function directionOf(m: SketchModel, refs: string[]): Vec2 | null {
  const [a, b] = refs
  const ea = entityById(m, a)
  if (ea?.type === 'line') { const [p, q] = lineEnds(m, ea); return sub(q, p) }
  if (b && (a === 'O' || ea?.type === 'point') ) return sub(pos(m, b), pos(m, a))
  return null
}
/** Start point of a single-line / two-point angle dimension (where the angle is measured). */
export function angleOrigin(m: SketchModel, refs: string[]): Vec2 {
  const ea = entityById(m, refs[0])
  return ea?.type === 'line' ? pos(m, ea.p1) : pos(m, refs[0])
}

/** Current actual value of a dimension-type constraint (mm / deg), from the geometry. */
export function measure(m: SketchModel, type: Constraint['type'], refs: string[]): Measured | null {
  const [a, b] = refs
  const sg = (v: number): 1 | -1 => (v < 0 ? -1 : 1)
  switch (type) {
    case 'distance': {
      const eb = entityById(m, b)
      if (eb?.type === 'line') {
        const [p, q] = lineEnds(m, eb)
        return { value: dist(pos(m, a), closestOnLine(pos(m, a), p, q)), sgn: 1 }
      }
      return { value: dist(pos(m, a), pos(m, b)), sgn: 1 }
    }
    case 'hdist': { const d = pos(m, b)[0] - pos(m, a)[0]; return { value: Math.abs(d), sgn: sg(d) } }
    case 'vdist': { const d = pos(m, b)[1] - pos(m, a)[1]; return { value: Math.abs(d), sgn: sg(d) } }
    case 'radius':
    case 'diameter': {
      const e = entityById(m, a)
      if (e?.type === 'ellipse' && type === 'radius') return { value: e.r, sgn: 1 }
      if (!e || (e.type !== 'circle' && e.type !== 'arc')) return null
      const r = circleOf(m, e).r
      return { value: type === 'radius' ? r : r * 2, sgn: 1 }
    }
    case 'majorRadius': {
      const e = entityById(m, a)
      return e?.type === 'ellipse' ? { value: dist(pos(m, e.c), pos(m, e.m)), sgn: 1 } : null
    }
    case 'angle': {
      const la = entityById(m, a), lb = b ? entityById(m, b) : undefined
      if (la?.type === 'line' && lb?.type === 'line') {
        const [p1, p2] = lineEnds(m, la), [q1, q2] = lineEnds(m, lb)
        const d1 = sub(p2, p1), d2 = sub(q2, q1)
        const ang = (Math.atan2(cross(d1, d2), dot(d1, d2)) * 180) / Math.PI
        return { value: Math.abs(ang), sgn: sg(ang) }
      }
      const dv = directionOf(m, refs)
      if (!dv) return null
      const ang = (Math.atan2(dv[1], dv[0]) * 180) / Math.PI
      return { value: Math.abs(ang), sgn: sg(ang) }
    }
    case 'offset': {
      const ea = entityById(m, a), eb = entityById(m, b)
      if (ea?.type === 'line' && eb?.type === 'line') {
        const [p, q] = lineEnds(m, eb)
        const A = pos(m, ea.p1)
        return { value: dist(A, closestOnLine(A, p, q)), sgn: 1 }
      }
      if ((ea?.type === 'circle' || ea?.type === 'arc') && (eb?.type === 'circle' || eb?.type === 'arc')) {
        const d = circleOf(m, ea).r - circleOf(m, eb).r
        return { value: Math.abs(d), sgn: sg(d) }
      }
      return null
    }
  }
  return null
}

/** Evaluate `expr` of every dimension (user parameters allowed). Returns the ids that failed. */
export function refreshDims(m: SketchModel): string[] {
  const bad: string[] = []
  for (const c of m.constraints) {
    if (!isDim(c) || c.expr === undefined) continue
    const v = evalNumber(c.expr, c.type === 'angle' ? 'deg' : 'mm')
    if (v === null) bad.push(c.id)
    else c.value = v
  }
  return bad
}

export function dimText(c: Constraint): string {
  const v = +(c.value ?? 0).toFixed(3)
  switch (c.type) {
    case 'radius': return 'R' + v
    case 'majorRadius': return 'Ra' + v
    case 'diameter': return '⌀' + v
    case 'angle': return v + '°'
    default: return String(v)
  }
}

export interface DimLayout {
  lines: Vec2[][]
  /** arrow tips with unit direction pointing along the dimension line, away from the tip */
  arrows: { tip: Vec2; dir: Vec2 }[]
  label: Vec2
}

const EXT = 1.5 // witness line extension past the dimension line, in mm-ish (scaled by caller via `k`)

export function layoutDim(m: SketchModel, c: Constraint, k = 1): DimLayout | null {
  const off = c.off
  if (!off) return null
  const [a, b] = c.refs
  const ext = EXT * k
  switch (c.type) {
    case 'distance': {
      const eb = entityById(m, b)
      const A = pos(m, a)
      let B: Vec2
      let line: [Vec2, Vec2] | null = null
      if (eb?.type === 'line') {
        line = lineEnds(m, eb)
        B = closestOnLine(A, line[0], line[1])
      } else B = pos(m, b)
      if (dist(A, B) < 1e-9) return null
      if (line) {
        // dimension perpendicular to the line, slid along it to `off`
        const u = norm(sub(line[1], line[0]))
        const s = dot(sub(off, B), u)
        const P1 = add(B, [u[0] * s, u[1] * s]), P2 = add(A, [u[0] * s, u[1] * s])
        const dir = norm(sub(P2, P1))
        return {
          lines: [[B, P1], [A, P2], [P1, P2]],
          arrows: [{ tip: P1, dir }, { tip: P2, dir: [-dir[0], -dir[1]] }],
          label: mid(P1, P2),
        }
      }
      const u = norm(sub(B, A)), n = perp(u)
      const d = dot(sub(off, A), n)
      const sgn = d < 0 ? -1 : 1
      const P1 = add(A, [n[0] * d, n[1] * d]), P2 = add(B, [n[0] * d, n[1] * d])
      const e: Vec2 = [n[0] * sgn * ext, n[1] * sgn * ext]
      return {
        lines: [[A, add(P1, e)], [B, add(P2, e)], [P1, P2]],
        arrows: [{ tip: P1, dir: u }, { tip: P2, dir: [-u[0], -u[1]] }],
        label: mid(P1, P2),
      }
    }
    case 'hdist': {
      const A = pos(m, a), B = pos(m, b)
      const y = off[1]
      const P1: Vec2 = [A[0], y], P2: Vec2 = [B[0], y]
      if (Math.abs(P1[0] - P2[0]) < 1e-9) return null
      const dir: Vec2 = [Math.sign(P2[0] - P1[0]), 0]
      const sgn = y >= A[1] ? 1 : -1
      return {
        lines: [[A, [A[0], y + sgn * ext]], [B, [B[0], y + (y >= B[1] ? 1 : -1) * ext]], [P1, P2]],
        arrows: [{ tip: P1, dir }, { tip: P2, dir: [-dir[0], 0] }],
        label: mid(P1, P2),
      }
    }
    case 'vdist': {
      const A = pos(m, a), B = pos(m, b)
      const x = off[0]
      const P1: Vec2 = [x, A[1]], P2: Vec2 = [x, B[1]]
      if (Math.abs(P1[1] - P2[1]) < 1e-9) return null
      const dir: Vec2 = [0, Math.sign(P2[1] - P1[1])]
      return {
        lines: [[A, [x + (x >= A[0] ? 1 : -1) * ext, A[1]]], [B, [x + (x >= B[0] ? 1 : -1) * ext, B[1]]], [P1, P2]],
        arrows: [{ tip: P1, dir }, { tip: P2, dir: [0, -dir[1]] }],
        label: mid(P1, P2),
      }
    }
    case 'majorRadius': {
      const e = entityById(m, a)
      if (e?.type !== 'ellipse') return null
      return layoutDim(m, { ...c, type: 'distance', refs: [e.c, e.m] }, k)
    }
    case 'radius':
    case 'diameter': {
      const e = entityById(m, a)
      if (e?.type === 'ellipse' && c.type === 'radius') {
        // the minor semi-axis: from the centre across the narrow way
        const C = pos(m, e.c), M = pos(m, e.m)
        const u = norm(sub(M, C)), v = perp(u)
        const side = dot(sub(off, C), v) < 0 ? -1 : 1
        const tip = add(C, [v[0] * e.r * side, v[1] * e.r * side])
        const L = Math.max(dist(off, C), e.r * 1.2)
        const dir: Vec2 = [v[0] * side, v[1] * side]
        return { lines: [[C, tip], [tip, add(C, [dir[0] * L, dir[1] * L])]], arrows: [{ tip, dir: [-dir[0], -dir[1]] }], label: add(C, [dir[0] * L, dir[1] * L]) }
      }
      if (!e || (e.type !== 'circle' && e.type !== 'arc')) return null
      const { c: C, r } = circleOf(m, e)
      let dir = sub(off, C)
      dir = len(dir) < 1e-9 ? [1, 0] : norm(dir)
      const tip = add(C, [dir[0] * r, dir[1] * r])
      const L = Math.max(dist(off, C), r * 0.4)
      if (c.type === 'radius') {
        return { lines: [[C, tip], ...(L > r ? [[tip, add(C, [dir[0] * L, dir[1] * L])] as Vec2[]] : [])], arrows: [{ tip, dir: [-dir[0], -dir[1]] }], label: add(C, [dir[0] * L, dir[1] * L]) }
      }
      const tip2 = add(C, [-dir[0] * r, -dir[1] * r])
      return {
        lines: [[tip2, tip], ...(L > r ? [[tip, add(C, [dir[0] * L, dir[1] * L])] as Vec2[]] : [])],
        arrows: [{ tip, dir: [-dir[0], -dir[1]] }, { tip: tip2, dir }],
        label: add(C, [dir[0] * L, dir[1] * L]),
      }
    }
    case 'angle': {
      const la = entityById(m, a), lb = b ? entityById(m, b) : undefined
      const sweep = (((c.value ?? 0) * (c.sgn ?? 1)) * Math.PI) / 180
      const arcOf = (I: Vec2, a1: number, R: number) => {
        const pts: Vec2[] = []
        const n = Math.max(6, Math.ceil(Math.abs(sweep) / 0.1))
        for (let i = 0; i <= n; i++) pts.push(polar(I, R, a1 + (sweep * i) / n))
        const tA = a1 + (Math.PI / 2) * Math.sign(sweep || 1), tB = a1 + sweep - (Math.PI / 2) * Math.sign(sweep || 1)
        return { pts, n, tA, tB }
      }
      if (la?.type === 'line' && lb?.type === 'line') {
        const [p1, p2] = lineEnds(m, la), [q1, q2] = lineEnds(m, lb)
        const hit = intersectLineLine(p1, p2, q1, q2)
        const I: Vec2 = hit ? hit.p : mid(p1, q1)
        const d1 = sub(p2, p1)
        const a1 = Math.atan2(d1[1], d1[0])
        const R = Math.max(dist(off, I), 2 * k)
        const { pts, n, tA, tB } = arcOf(I, a1, R)
        return {
          lines: [pts],
          arrows: [{ tip: pts[0], dir: [Math.cos(tA), Math.sin(tA)] }, { tip: pts[n], dir: [Math.cos(tB), Math.sin(tB)] }],
          label: polar(I, R, a1 + sweep / 2),
        }
      }
      // direction of one line / of two points, measured from the sketch +X axis
      if (!directionOf(m, c.refs)) return null
      const I = angleOrigin(m, c.refs)
      const R = Math.max(dist(off, I), 2 * k)
      const { pts, n, tA, tB } = arcOf(I, 0, R)
      return {
        lines: [pts, [I, [I[0] + R * 1.15, I[1]]], [I, polar(I, R * 1.15, sweep)]],
        arrows: [{ tip: pts[0], dir: [Math.cos(tA), Math.sin(tA)] }, { tip: pts[n], dir: [Math.cos(tB), Math.sin(tB)] }],
        label: polar(I, R, sweep / 2),
      }
    }
    case 'offset': {
      const ea = entityById(m, a), eb = entityById(m, b)
      if (ea?.type === 'line' && eb?.type === 'line') return layoutDim(m, { ...c, type: 'distance', refs: [ea.p1, b] }, k)
      if ((ea?.type === 'circle' || ea?.type === 'arc') && (eb?.type === 'circle' || eb?.type === 'arc')) {
        const { c: C, r: r0 } = circleOf(m, eb)
        const r1 = circleOf(m, ea).r
        let dir = sub(off, C)
        dir = len(dir) < 1e-9 ? [1, 0] : norm(dir)
        const P0 = add(C, [dir[0] * r0, dir[1] * r0]), P1 = add(C, [dir[0] * r1, dir[1] * r1])
        if (dist(P0, P1) < 1e-9) return null
        const u = norm(sub(P1, P0))
        return { lines: [[P0, P1]], arrows: [{ tip: P0, dir: u }, { tip: P1, dir: [-u[0], -u[1]] }], label: mid(P0, P1) }
      }
      return null
    }
  }
  return null
}

/** Sensible initial label position for a new dimension. */
export function defaultOff(m: SketchModel, type: Constraint['type'], refs: string[], k: number): Vec2 {
  const [a, b] = refs
  const gap = 6 * k
  switch (type) {
    case 'distance': {
      const eb = entityById(m, b)
      const A = pos(m, a)
      if (eb?.type === 'line') {
        const [p, q] = lineEnds(m, eb)
        return add(mid(A, closestOnLine(A, p, q)), perp(norm(sub(q, p))).map((v) => v * gap) as Vec2)
      }
      const B = pos(m, b)
      const n = perp(norm(sub(B, A)))
      return add(mid(A, B), [n[0] * gap, n[1] * gap])
    }
    case 'hdist': return [(pos(m, a)[0] + pos(m, b)[0]) / 2, Math.max(pos(m, a)[1], pos(m, b)[1]) + gap]
    case 'vdist': return [Math.max(pos(m, a)[0], pos(m, b)[0]) + gap, (pos(m, a)[1] + pos(m, b)[1]) / 2]
    case 'majorRadius': {
      const e = entityById(m, a)
      return e?.type === 'ellipse' ? defaultOff(m, 'distance', [e.c, e.m], k) : [0, 0]
    }
    case 'radius':
    case 'diameter': {
      const e = entityById(m, a)
      if (e?.type === 'ellipse') { const c = pos(m, e.c), u = norm(sub(pos(m, e.m), c)); return add(c, [-u[1] * e.r * 1.4, u[0] * e.r * 1.4]) }
      if (!e || (e.type !== 'circle' && e.type !== 'arc')) return [0, 0]
      const { c, r } = circleOf(m, e)
      return polar(c, r * 1.4, Math.PI / 4)
    }
    case 'angle': {
      const la = entityById(m, a), lb = b ? entityById(m, b) : undefined
      if (la?.type === 'line' && lb?.type === 'line') {
        const [p1, p2] = lineEnds(m, la), [q1, q2] = lineEnds(m, lb)
        const hit = intersectLineLine(p1, p2, q1, q2)
        const I = hit ? hit.p : mid(p1, q1)
        const d1 = norm(sub(p2, p1)), d2 = norm(sub(q2, q1))
        return add(I, [(d1[0] + d2[0]) * 5 * k, (d1[1] + d2[1]) * 5 * k])
      }
      const dv = directionOf(m, refs)
      if (!dv) return [0, 0]
      const I = angleOrigin(m, refs)
      return polar(I, 7 * k, Math.atan2(dv[1], dv[0]) / 2)
    }
    case 'offset': {
      const ea = entityById(m, a), eb = entityById(m, b)
      if (ea?.type === 'line' && eb?.type === 'line') return defaultOff(m, 'distance', [ea.p1, b], k)
      if ((ea?.type === 'circle' || ea?.type === 'arc') && (eb?.type === 'circle' || eb?.type === 'arc')) {
        const { c, r } = circleOf(m, ea)
        return polar(c, r + 2 * k, Math.PI / 4)
      }
      return [0, 0]
    }
  }
  return [0, 0]
}
