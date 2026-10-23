/**
 * Independent constraint evaluation for a SketchModel: residuals of every constraint, numerical Jacobian, and the
 * rank structure of it.
 *
 *  - `freedom(model)` finds exactly which points / circles can still move (the entities that take part in a degree of
 *    freedom) with a Gauss-Jordan elimination of the Jacobian, one connected component of the constraint graph at a
 *    time. That is what colours geometry as fully constrained, and it needs no solver run at all.
 *  - `maxResidual(model)` re-checks a solver result against the constraints (used to accept a drag that planegcs
 *    reports as "failed" only because its soft pull targets contradict each other).
 *
 * The sum of the free directions equals the DOF reported by planegcs (checked by the tests).
 */
import { ORIGIN, type SketchModel, type Vec2 } from './types'
import { entityById } from './model'

type Fn = () => number[]
interface Eq { f: Fn; vars: number[] }

const TAU = Math.PI * 2
const wrap = (a: number) => {
  let d = (a + Math.PI) % TAU
  if (d < 0) d += TAU
  return d - Math.PI
}

interface System {
  x: number[]
  eqs: Eq[]
  /** unknown index -> owner entity id (point or circle) */
  owner: string[]
}

function build(m: SketchModel): System {
  const x: number[] = []
  const owner: string[] = []
  const idx = new Map<string, number>() // point id -> index of its x (y follows); circle id -> index of its radius
  const fixedByConstraint = new Set(m.constraints.filter((c) => c.type === 'fix').map((c) => c.refs[0]))
  for (const e of m.entities) {
    if (e.type === 'point' && !e.ref && !fixedByConstraint.has(e.id)) { idx.set(e.id, x.length); x.push(e.x, e.y); owner.push(e.id, e.id) }
    else if (e.type === 'circle' && !e.ref) { idx.set(e.id, x.length); x.push(e.r); owner.push(e.id) }
  }
  const P = (id: string): Vec2 => {
    const i = idx.get(id)
    if (i !== undefined) return [x[i], x[i + 1]]
    if (id === ORIGIN) return [0, 0]
    const e = entityById(m, id)
    return e && e.type === 'point' ? [e.x, e.y] : [0, 0]
  }
  const ent = (id: string) => entityById(m, id)
  /** unknown indices an entity depends on */
  const varsOf = (...ids: string[]): number[] => {
    const out: number[] = []
    const add = (id: string) => {
      const i = idx.get(id)
      if (i === undefined) return
      const e = ent(id)
      if (e?.type === 'circle') out.push(i)
      else out.push(i, i + 1)
    }
    for (const id of ids) {
      const e = ent(id)
      if (!e) { add(id); continue }
      if (e.type === 'point') add(id)
      else if (e.type === 'line') { add(e.p1); add(e.p2) }
      else if (e.type === 'circle') { add(e.c); add(e.id) }
      else { add(e.c); add(e.s); add(e.e) }
    }
    return out
  }
  const L = (id: string): [Vec2, Vec2] => {
    const e = ent(id)
    return e && e.type === 'line' ? [P(e.p1), P(e.p2)] : [[0, 0], [1, 0]]
  }
  const dir = (id: string): Vec2 => { const [a, b] = L(id); return [b[0] - a[0], b[1] - a[1]] }
  const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0]
  const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1]
  const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1])
  const rad = (id: string): number => {
    const e = ent(id)
    if (!e) return 0
    if (e.type === 'circle') { const i = idx.get(e.id); return i !== undefined ? x[i] : e.r }
    if (e.type === 'arc') return dist(P(e.c), P(e.s))
    return 0
  }
  const center = (id: string): Vec2 => { const e = ent(id); return e && (e.type === 'circle' || e.type === 'arc') ? P(e.c) : [0, 0] }
  const isLine = (id: string) => ent(id)?.type === 'line'
  /** signed distance of a point from the infinite line of `lineId` */
  const sdist = (p: Vec2, lineId: string) => {
    const [a, b] = L(lineId)
    const d: Vec2 = [b[0] - a[0], b[1] - a[1]]
    return cross(d, [p[0] - a[0], p[1] - a[1]]) / (Math.hypot(d[0], d[1]) || 1)
  }

  /** direction of curve `id` at point p (lines run p1 -> p2, arcs / circles counter-clockwise) */
  const tangentAtPoint = (id: string, p: Vec2): Vec2 => {
    if (isLine(id)) return dir(id)
    const cc = center(id)
    return [-(p[1] - cc[1]), p[0] - cc[0]]
  }

  const eqs: Eq[] = []
  const push = (ids: string[], f: Fn) => eqs.push({ f, vars: varsOf(...ids) })

  for (const e of m.entities) if (e.type === 'arc' && !e.ref) push([e.id], () => [dist(P(e.s), P(e.c)) - dist(P(e.e), P(e.c))])

  for (const c of m.constraints) {
    const [a, b] = c.refs
    const v = c.value ?? 0
    const sg = c.sgn ?? 1
    switch (c.type) {
      case 'fix': break
      case 'coincident': push([a, b], () => { const A = P(a), B = P(b); return [A[0] - B[0], A[1] - B[1]] }); break
      case 'pointOnLine': push([a, b], () => [sdist(P(a), b)]); break
      case 'pointOnCurve': push([a, b], () => [dist(P(a), center(b)) - rad(b)]); break
      case 'onAxis': push([a], () => [c.axis === 'x' ? P(a)[1] : P(a)[0]]); break
      case 'midpoint': push([a, b], () => { const [p, q] = L(b), A = P(a); return [A[0] - (p[0] + q[0]) / 2, A[1] - (p[1] + q[1]) / 2] }); break
      case 'horizontal': push([a, ...(b ? [b] : [])], () => (b ? [P(a)[1] - P(b)[1]] : [dir(a)[1]])); break
      case 'vertical': push([a, ...(b ? [b] : [])], () => (b ? [P(a)[0] - P(b)[0]] : [dir(a)[0]])); break
      case 'parallel': push([a, b], () => { const d1 = dir(a), d2 = dir(b); return [cross(d1, d2) / ((Math.hypot(...d1) * Math.hypot(...d2)) || 1)] }); break
      case 'perpendicular': push([a, b], () => { const d1 = dir(a), d2 = dir(b); return [dot(d1, d2) / ((Math.hypot(...d1) * Math.hypot(...d2)) || 1)] }); break
      case 'tangent':
        if (isLine(a) || isLine(b)) {
          const l = isLine(a) ? a : b, k = isLine(a) ? b : a
          push([a, b], () => [Math.abs(sdist(center(k), l)) - rad(k)])
        } else {
          push([a, b], () => {
            const d = dist(center(a), center(b)), r1 = rad(a), r2 = rad(b)
            const ext = d - (r1 + r2), int = d - Math.abs(r1 - r2)
            return [Math.abs(ext) <= Math.abs(int) ? ext : int]
          })
        }
        break
      case 'tangentAt':
        push([a, b, c.refs[2]], () => {
          const p = P(c.refs[2])
          const t1 = tangentAtPoint(a, p), t2 = tangentAtPoint(b, p)
          return [wrap(Math.atan2(cross(t1, t2), dot(t1, t2)) - (v * Math.PI) / 180)]
        })
        break
      case 'equal': push([a, b], () => (isLine(a) ? [Math.hypot(...dir(a)) - Math.hypot(...dir(b))] : [rad(a) - rad(b)])); break
      case 'distance':
        push([a, b], () => (isLine(b) ? [Math.abs(sdist(P(a), b)) - v] : [dist(P(a), P(b)) - v]))
        break
      case 'hdist': push([a, b], () => [P(b)[0] - P(a)[0] - v * sg]); break
      case 'vdist': push([a, b], () => [P(b)[1] - P(a)[1] - v * sg]); break
      case 'radius': push([a], () => [rad(a) - v]); break
      case 'diameter': push([a], () => [2 * rad(a) - v]); break
      case 'angle':
        if (b && isLine(a) && isLine(b)) push([a, b], () => { const d1 = dir(a), d2 = dir(b); return [wrap(Math.atan2(cross(d1, d2), dot(d1, d2)) - (v * sg * Math.PI) / 180)] })
        else {
          const l = isLine(a) ? (ent(a) as { p1: string; p2: string }) : null
          const p1 = l ? l.p1 : a, p2 = l ? l.p2 : b
          push([p1, p2], () => { const A = P(p1), B = P(p2); return [wrap(Math.atan2(B[1] - A[1], B[0] - A[0]) - (v * sg * Math.PI) / 180)] })
        }
        break
      case 'offset':
        if (isLine(a)) {
          const l = ent(a) as { p1: string }
          push([a, b], () => [Math.abs(sdist(P(l.p1), b)) - v])
        } else push([a, b], () => [rad(a) - rad(b) - v * sg])
        break
    }
  }
  return { x, eqs, owner }
}

/** Largest absolute residual over all constraints at the model's current geometry. */
export function maxResidual(m: SketchModel): number {
  const s = build(m)
  let worst = 0
  for (const e of s.eqs) for (const r of e.f()) worst = Math.max(worst, Math.abs(r))
  return worst
}

export interface Freedom {
  /** degrees of freedom (unknowns minus rank of the Jacobian) */
  dof: number
  /** ids of points / circles that can still move */
  free: Set<string>
}

/** Rank structure of the constraint Jacobian: which unknowns are determined, and how many degrees of freedom remain. */
export function freedom(m: SketchModel): Freedom {
  const s = build(m)
  const n = s.x.length
  // connected components of unknowns linked by an equation
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (const e of s.eqs) for (let k = 1; k < e.vars.length; k++) parent[find(e.vars[k])] = find(e.vars[0])
  const comps = new Map<number, { vars: number[]; eqs: Eq[] }>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    ;(comps.get(r) ?? comps.set(r, { vars: [], eqs: [] }).get(r)!).vars.push(i)
  }
  for (const e of s.eqs) if (e.vars.length) comps.get(find(e.vars[0]))!.eqs.push(e)

  const freeVars = new Set<number>()
  let dof = 0
  const H = 1e-6
  for (const comp of comps.values()) {
    const { vars, eqs } = comp
    const nv = vars.length
    if (!eqs.length) { vars.forEach((v) => freeVars.add(v)); dof += nv; continue }
    // Jacobian by central differences (rows = scalar residuals, columns = this component's unknowns)
    const rows: number[][] = []
    const nRes = eqs.map((e) => e.f().length)
    nRes.forEach((k) => { for (let i = 0; i < k; i++) rows.push(new Array(nv).fill(0)) })
    vars.forEach((v, col) => {
      const x0 = s.x[v]
      const h = H * (1 + Math.abs(x0))
      s.x[v] = x0 + h
      const plus = eqs.flatMap((e) => e.f())
      s.x[v] = x0 - h
      const minus = eqs.flatMap((e) => e.f())
      s.x[v] = x0
      for (let r = 0; r < rows.length; r++) rows[r][col] = (plus[r] - minus[r]) / (2 * h)
    })
    // normalise rows so angles and lengths are comparable, then Gauss-Jordan
    for (const row of rows) {
      const mx = Math.max(...row.map(Math.abs))
      if (mx > 0) for (let j = 0; j < nv; j++) row[j] /= mx
    }
    const TOL = 1e-6
    const pivotCol: number[] = []
    let r0 = 0
    for (let c = 0; c < nv && r0 < rows.length; c++) {
      let best = r0
      for (let r = r0 + 1; r < rows.length; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[best][c])) best = r
      if (Math.abs(rows[best][c]) < TOL) continue
      ;[rows[r0], rows[best]] = [rows[best], rows[r0]]
      const pv = rows[r0][c]
      for (let j = c; j < nv; j++) rows[r0][j] /= pv
      for (let r = 0; r < rows.length; r++) {
        if (r === r0) continue
        const f = rows[r][c]
        if (Math.abs(f) < 1e-14) continue
        for (let j = c; j < nv; j++) rows[r][j] -= f * rows[r0][j]
      }
      pivotCol.push(c)
      r0++
    }
    const pivots = new Set(pivotCol)
    const freeCols = Array.from({ length: nv }, (_, i) => i).filter((i) => !pivots.has(i))
    dof += freeCols.length
    for (const f of freeCols) freeVars.add(vars[f])
    pivotCol.forEach((c, r) => {
      if (freeCols.some((f) => Math.abs(rows[r][f]) > TOL)) freeVars.add(vars[c])
    })
  }
  // a point's x and y are separate unknowns; an entity is free when either coordinate is
  const free = new Set<string>()
  for (const v of freeVars) free.add(s.owner[v])
  return { dof, free }
}
