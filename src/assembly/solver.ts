/**
 * Kinematic solver. Joints connect occurrences into a graph; each connected set has a root that stays where the occurrence tree
 * puts it (a grounded occurrence, else the first one), and the others are placed by walking the joints out from it:
 *
 *   frame(b) = frame(a) * T(joint, values)         with frame(x) = world(x) * origin(x)
 *
 * A joint that closes a loop is checked instead of walked. When a loop does not close with the stored values, the free joint
 * values of the set (everything not driven and not set by a motion link) are adjusted with damped Gauss-Newton until it does.
 * If it cannot close the set is over-constrained: the joints of the loop get an error and the set stays at its tree solution.
 */
import { clampValue, dofsOf, jointTransform, originMatrix } from './joints'
import { chain, identity, invert, multiply, poseError, type Mat4 } from './matrix'
import type { AssemblyData, Joint } from './types'

/** One placed thing in the flattened occurrence tree: the id is the occurrence path, the parent the path of the node it sits in. */
export interface PlacedNode { id: string; parent: string | null; transform: Mat4; grounded?: boolean }
export interface SolveInput { nodes: PlacedNode[]; joints: Joint[]; links: AssemblyData['links'] }

export type DriveMap = Record<string, Record<string, number>>

export interface SolveResult {
  /** world placement of every occurrence (joint-placed ones and everything inside them included) */
  worlds: Record<string, Mat4>
  /** the values every joint ended up with (links, limits and loop closing applied) */
  values: Record<string, Record<string, number>>
  /** problems by joint id */
  errors: Record<string, string>
  /** problems by motion link id */
  linkErrors: Record<string, string>
  /** occurrences that a joint places (so they cannot be dragged freely) */
  placed: Set<string>
  /** the placements the joints gave those occurrences */
  over: Record<string, Mat4>
  /** for every placed occurrence, the joint that placed it (the one closest to its root) */
  via: Record<string, string>
  /** true when a set of joints could not be satisfied */
  overConstrained: boolean
}

const TOL = 1e-6
type Values = Record<string, Record<string, number>>

export function occurrenceMap(data: { nodes: PlacedNode[] }): Map<string, PlacedNode> {
  return new Map(data.nodes.map((o) => [o.id, o]))
}

function ancestors(occ: string, byId: Map<string, PlacedNode>): string[] {
  const out: string[] = []
  let cur = byId.get(occ)?.parent ?? null
  const seen = new Set<string>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    out.push(cur)
    cur = byId.get(cur)?.parent ?? null
  }
  return out
}

/** World placement of an occurrence given the placements fixed so far (`over`) and the tree's own transforms. */
export function worldOf(occ: string, byId: Map<string, PlacedNode>, over: Record<string, Mat4>, memo: Record<string, Mat4> = {}): Mat4 {
  if (memo[occ]) return memo[occ]
  const o = byId.get(occ)
  let w: Mat4
  if (!o) w = identity()
  else if (over[occ]) w = over[occ]
  else w = multiply(o.parent ? worldOf(o.parent, byId, over, memo) : identity(), o.transform)
  memo[occ] = w
  return w
}

/** Joint values after drive overrides, motion links and limits. */
export function effectiveValues(data: Pick<AssemblyData, 'joints' | 'links'>, drive: DriveMap = {}): { values: Values; linkErrors: Record<string, string>; dependent: Set<string> } {
  const values: Values = {}
  for (const j of data.joints) {
    const v: Record<string, number> = {}
    for (const d of dofsOf(j.type)) v[d.key] = clampValue(j, d.key, drive[j.id]?.[d.key] ?? j.values[d.key] ?? 0)
    values[j.id] = v
  }
  const linkErrors: Record<string, string> = {}
  const dependent = new Set<string>()
  const byJoint = new Map(data.joints.map((j) => [j.id, j]))
  // links are applied in dependency order: a link's source may itself be the target of another link
  const pending = data.links.filter((l) => {
    const ja = byJoint.get(l.a.joint), jb = byJoint.get(l.b.joint)
    if (!ja || !jb) { linkErrors[l.id] = 'A joint of this link no longer exists'; return false }
    if (!(l.a.key in values[ja.id]) || !(l.b.key in values[jb.id])) { linkErrors[l.id] = 'A degree of freedom of this link no longer exists'; return false }
    if (l.a.joint === l.b.joint && l.a.key === l.b.key) { linkErrors[l.id] = 'A link cannot drive itself'; return false }
    return true
  })
  const targets = new Set(pending.map((l) => l.b.joint + ':' + l.b.key))
  const done = new Set<string>()
  let left = pending.slice()
  for (let guard = 0; left.length && guard <= pending.length; guard++) {
    const next: typeof left = []
    for (const l of left) {
      const src = l.a.joint + ':' + l.a.key
      if (targets.has(src) && !done.has(src)) { next.push(l); continue }
      const ja = byJoint.get(l.a.joint)!, jb = byJoint.get(l.b.joint)!
      values[jb.id][l.b.key] = clampValue(jb, l.b.key, values[ja.id][l.a.key] * l.ratio)
      done.add(l.b.joint + ':' + l.b.key)
      dependent.add(l.b.joint + ':' + l.b.key)
    }
    left = next
  }
  for (const l of left) linkErrors[l.id] = 'Motion links drive each other in a circle'
  return { values, linkErrors, dependent }
}

interface Edge { joint: Joint; from: string; to: string }

interface SetSolve { poses: Record<string, Mat4>; residual: number[]; tree: Set<string>; via: Record<string, string> }

/** Walk the joints of one connected set from its roots; returns poses of the non-root members and the residual of every loop joint. */
function walk(roots: Map<string, Mat4>, members: string[], joints: Joint[], values: Values): SetSolve {
  const poses: Record<string, Mat4> = {}
  const via: Record<string, string> = {}
  const known = new Map(roots)
  const queue = [...roots.keys()]
  const tree = new Set<string>()
  const adj = new Map<string, Joint[]>()
  for (const j of joints) {
    for (const o of [j.a.occ, j.b.occ]) (adj.get(o) ?? adj.set(o, []).get(o)!).push(j)
  }
  while (queue.length) {
    const x = queue.shift()!
    const wx = known.get(x)!
    for (const j of adj.get(x) ?? []) {
      if (tree.has(j.id)) continue
      const y = j.a.occ === x ? j.b.occ : j.a.occ
      if (known.has(y)) continue
      const T = jointTransform(j, values[j.id])
      const Oa = originMatrix(j.a.frame), Ob = originMatrix(j.b.frame)
      const wy = j.a.occ === x
        ? chain(wx, Oa, T, invert(Ob)) // x = a, y = b
        : chain(wx, Ob, invert(T), invert(Oa)) // x = b, y = a
      known.set(y, wy)
      poses[y] = wy
      via[y] = j.id
      tree.add(j.id)
      queue.push(y)
    }
  }
  const residual: number[] = []
  for (const j of joints) {
    if (tree.has(j.id)) continue
    const wa = known.get(j.a.occ), wb = known.get(j.b.occ)
    if (!wa || !wb) continue
    const T = jointTransform(j, values[j.id])
    residual.push(...poseError(chain(wa, originMatrix(j.a.frame), T), chain(wb, originMatrix(j.b.frame))))
  }
  // occurrences never reached (should not happen for a connected set) keep their tree placement
  void members
  return { poses, residual, tree, via }
}

const norm2 = (r: number[]) => Math.sqrt(r.reduce((s, v) => s + v * v, 0))

/** Solve a small dense least squares step: (JtJ + lambda I) d = -Jt r. */
function lmStep(J: number[][], r: number[], lambda: number): number[] {
  const n = J[0]?.length ?? 0
  const A: number[][] = Array.from({ length: n }, () => new Array(n + 1).fill(0))
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) for (let m = 0; m < r.length; m++) A[i][k] += J[m][i] * J[m][k]
    A[i][i] += lambda
    for (let m = 0; m < r.length; m++) A[i][n] -= J[m][i] * r[m]
  }
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r2 = c + 1; r2 < n; r2++) if (Math.abs(A[r2][c]) > Math.abs(A[p][c])) p = r2
    ;[A[c], A[p]] = [A[p], A[c]]
    if (Math.abs(A[c][c]) < 1e-14) continue
    for (let r2 = 0; r2 < n; r2++) {
      if (r2 === c) continue
      const f = A[r2][c] / A[c][c]
      for (let k = c; k <= n; k++) A[r2][k] -= f * A[c][k]
    }
  }
  return A.map((row, i) => (Math.abs(row[i]) < 1e-14 ? 0 : row[n] / row[i]))
}

/**
 * Damped Gauss-Newton on a residual function of a few unknowns (numeric Jacobian). `clamp` keeps an unknown inside its limits.
 * Returns the best unknowns found, which are the starting ones when nothing improved.
 */
export function lmSolve(f: (u: number[]) => number[], u0: number[], o: { iterations?: number; tol?: number; h?: number; clamp?: (v: number, i: number) => number } = {}): number[] {
  const { iterations = 60, tol = 1e-8, h = 1e-4, clamp = (v: number) => v } = o
  let u = u0.map((v, i) => clamp(v, i))
  let r = f(u)
  let lambda = 1e-3
  for (let it = 0; it < iterations && norm2(r) > tol; it++) {
    const J: number[][] = r.map(() => new Array(u.length).fill(0))
    for (let i = 0; i < u.length; i++) {
      const up = u.slice()
      up[i] += h
      const rp = f(up)
      for (let m = 0; m < r.length; m++) J[m][i] = (rp[m] - r[m]) / h
    }
    let improved = false
    for (let k = 0; k < 8 && !improved; k++) {
      const d = lmStep(J, r, lambda)
      const un = u.map((v, i) => clamp(v + d[i], i))
      const rn = f(un)
      if (norm2(rn) < norm2(r) - 1e-14) {
        const step = Math.max(...un.map((v, i) => Math.abs(v - u[i])))
        u = un
        r = rn
        lambda = Math.max(1e-9, lambda / 4)
        improved = true
        if (step < 1e-7) return u // at a minimum the residual cannot get below (a target out of reach)
      } 
      else lambda *= 4
    }
    if (!improved) break
  }
  return u
}

export function solveAssembly(data: SolveInput, drive: DriveMap = {}): SolveResult {
  const byId = occurrenceMap(data)
  const { values, linkErrors, dependent } = effectiveValues(data, drive)
  const errors: Record<string, string> = {}
  const placed = new Set<string>()
  const over: Record<string, Mat4> = {}
  const via: Record<string, string> = {}
  let overConstrained = false

  const active = data.joints.filter((j) => {
    if (j.suppressed) return false
    if (!byId.has(j.a.occ) || !byId.has(j.b.occ)) { errors[j.id] = 'A component of this joint no longer exists'; return false }
    if (j.a.occ === j.b.occ) { errors[j.id] = 'A joint needs two different components'; return false }
    if (ancestors(j.a.occ, byId).includes(j.b.occ) || ancestors(j.b.occ, byId).includes(j.a.occ)) {
      errors[j.id] = 'A joint cannot connect a component with one inside it'
      return false
    }
    return true
  })

  // connected sets of occurrences
  const parent = new Map<string, string>()
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; return r }
  for (const j of active) for (const o of [j.a.occ, j.b.occ]) if (!parent.has(o)) parent.set(o, o)
  for (const j of active) parent.set(find(j.a.occ), find(j.b.occ))
  const sets = new Map<string, string[]>()
  for (const o of parent.keys()) (sets.get(find(o)) ?? sets.set(find(o), []).get(find(o))!).push(o)
  const order = data.nodes.map((o) => o.id)
  const depth = (o: string) => ancestors(o, byId).length
  const setList = [...sets.values()]
    .map((m) => m.sort((a, b) => order.indexOf(a) - order.indexOf(b)))
    .sort((a, b) => Math.min(...a.map(depth)) - Math.min(...b.map(depth)))

  for (const members of setList) {
    const joints = active.filter((j) => members.includes(j.a.occ))
    const grounded = members.filter((m) => byId.get(m)?.grounded)
    const rootIds = grounded.length ? grounded : [members[0]]
    const roots = new Map<string, Mat4>()
    for (const r of rootIds) roots.set(r, worldOf(r, byId, over))

    let sol = walk(roots, members, joints, values)
    let res = norm2(sol.residual)
    if (res > TOL) {
      // a loop that does not close: adjust the free joint values
      const unknowns: { joint: string; key: string }[] = []
      for (const j of joints) for (const d of dofsOf(j.type)) {
        if (drive[j.id]?.[d.key] !== undefined || dependent.has(j.id + ':' + d.key)) continue
        unknowns.push({ joint: j.id, key: d.key })
      }
      const trial = (u: number[]) => {
        const v: Values = {}
        for (const k of Object.keys(values)) v[k] = { ...values[k] }
        unknowns.forEach((x, i) => {
          const j = joints.find((q) => q.id === x.joint)!
          v[x.joint][x.key] = clampValue(j, x.key, u[i])
        })
        return v
      }
      if (unknowns.length) {
        const u = lmSolve((x) => walk(roots, members, joints, trial(x)).residual, unknowns.map((x) => values[x.joint][x.key]), { iterations: 80, tol: TOL })
        const cur = walk(roots, members, joints, trial(u))
        const rn = norm2(cur.residual)
        if (rn <= 1e-4) {
          const v = trial(u)
          for (const k of Object.keys(v)) values[k] = v[k]
          sol = cur
          res = rn
        }
      }
    }
    if (res > 1e-4) {
      overConstrained = true
      const msg = unknownsMessage(joints, drive, dependent)
      for (const j of joints) if (!sol.tree.has(j.id)) errors[j.id] = msg
      // tell the user which joints form the loop: every joint of a set that has a closing joint
      for (const j of joints) errors[j.id] ??= 'Part of a loop of joints that cannot be satisfied together'
    }
    for (const [o, w] of Object.entries(sol.poses)) { over[o] = w; placed.add(o) }
    Object.assign(via, sol.via)
  }

  const memo: Record<string, Mat4> = {}
  const worlds: Record<string, Mat4> = {}
  for (const o of data.nodes) worlds[o.id] = worldOf(o.id, byId, over, memo)
  return { worlds, values, errors, linkErrors, placed, over, via, overConstrained }
}

function unknownsMessage(joints: Joint[], drive: DriveMap, dependent: Set<string>): string {
  const free = joints.some((j) => dofsOf(j.type).some((d) => drive[j.id]?.[d.key] === undefined && !dependent.has(j.id + ':' + d.key)))
  return free
    ? 'Over-constrained: this joint closes a loop of components that cannot reach each other with the joint limits'
    : 'Over-constrained: every joint of this loop is fixed (driven or linked), so the loop cannot close'
}
