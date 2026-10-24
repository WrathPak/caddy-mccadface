/** Turning the component tree + the bodies the timeline produced into the placed instances the viewport and exports use. */
import type { Body } from '@/kernel/types'
import { identity, multiply, translation, mul, norm, type Mat4 } from './matrix'
import { refreshJoints } from './snaps'
import { occurrenceMap, solveAssembly, worldOf, type DriveMap, type PlacedNode, type SolveResult } from './solver'
import { ROOT, type AssemblyData, type ExplodeStep } from './types'

/** An instance of an occurrence: the node the solver places. `id` is the occurrence path. */
export interface OccNode extends PlacedNode {
  /** the stored occurrence (last segment of the path) */
  occ: string
  component: string
}

export const lastOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const parentPath = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null)
/** True when `path` is `of` or inside it. */
export const within = (path: string, of: string) => path === of || path.startsWith(of + '/')

/**
 * Expand the occurrences into instances: every occurrence of the root, then, inside each, the occurrences of its component,
 * and so on. A component that contains itself is cut off where it would loop.
 */
export function flatten(a: Pick<AssemblyData, 'occurrences'>): OccNode[] {
  const byParent = new Map<string, AssemblyData['occurrences']>()
  for (const o of a.occurrences) (byParent.get(o.parent) ?? byParent.set(o.parent, []).get(o.parent)!).push(o)
  const out: OccNode[] = []
  const visit = (def: string, path: string | null, stack: string[]) => {
    for (const o of byParent.get(def) ?? []) {
      if (stack.includes(o.component)) continue
      const id = path ? `${path}/${o.id}` : o.id
      out.push({ id, occ: o.id, component: o.component, parent: path, transform: o.transform, grounded: o.grounded })
      visit(o.component, id, [...stack, o.component])
    }
  }
  visit(ROOT, null, [ROOT])
  return out
}

export interface Instance {
  /** unique per instance and body */
  key: string
  /** the instance path ('' for bodies of the root component itself) */
  occ: string
  def: string
  /** same as occ; kept for the persistent-name paths of refs */
  path: string
  body: Body
  /** the instance's placement */
  pose: Mat4
  /** pose * the body's own placement inside its component (set for bodies of linked components) */
  world: Mat4
}

/** The component that owns a body: where Create Components from Bodies moved it, else the one of the feature that made it. */
export const ownerOf = (b: Pick<Body, 'id' | 'component'>, a: Pick<AssemblyData, 'bodyOwner'>): string => a.bodyOwner[b.id] ?? b.component ?? ROOT

export function expandInstances(a: Pick<AssemblyData, 'occurrences' | 'bodyOwner'>, bodies: Body[], worlds: Record<string, Mat4> = {}): Instance[] {
  const byDef = new Map<string, Body[]>()
  for (const b of bodies) {
    const d = ownerOf(b, a)
    ;(byDef.get(d) ?? byDef.set(d, []).get(d)!).push(b)
  }
  const out: Instance[] = []
  const emit = (path: string, def: string, pose: Mat4) => {
    for (const b of byDef.get(def) ?? []) out.push({ key: `${path}|${b.id}`, occ: path, def, path, body: b, pose, world: b.placement ? multiply(pose, b.placement) : pose })
  }
  emit('', ROOT, identity())
  for (const n of flatten(a)) emit(n.id, n.component, worlds[n.id] ?? identity())
  return out
}

/**
 * Offsets (world translation) the explode steps give every instance at `amount` (0 collapsed, 1 fully exploded); children follow their
 * parent. The steps play one after the other: with n steps, step k is under way while amount is between k/n and (k+1)/n.
 */
export function explodeOffsets(nodes: PlacedNode[], steps: ExplodeStep[], amount: number): Record<string, [number, number, number]> {
  const byId = occurrenceMap({ nodes })
  const own: Record<string, [number, number, number]> = {}
  steps.forEach((s, k) => {
    const progress = Math.min(1, Math.max(0, amount * steps.length - k))
    const d = mul(norm(s.direction), s.distance * progress)
    for (const o of s.occs) {
      const c = own[o] ?? [0, 0, 0]
      own[o] = [c[0] + d[0], c[1] + d[1], c[2] + d[2]]
    }
  })
  const total: Record<string, [number, number, number]> = {}
  for (const n of nodes) {
    let t: [number, number, number] = [0, 0, 0]
    let cur: string | null = n.id
    const seen = new Set<string>()
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      const v = own[cur]
      if (v) t = [t[0] + v[0], t[1] + v[1], t[2] + v[2]]
      cur = byId.get(cur)!.parent
    }
    if (t[0] || t[1] || t[2]) total[n.id] = t
  }
  return total
}

export interface Placement {
  solve: SolveResult
  /** joints whose origin lost its snap point (the origin keeps its last frame), by joint id */
  frameErrors: Record<string, string>
  nodes: OccNode[]
  /** what to draw: solved placements, the active instance at its own origin, explode offsets applied */
  worlds: Record<string, Mat4>
}

/**
 * Placements for display. The active instance is shown at its own origin (so sketches and features line up with the origin
 * planes you work on), the explode offsets move the others. With `geometry` the joint origins follow their snap points.
 */
export function placeAssembly(a: AssemblyData, drive: DriveMap = {}, activeOcc: string | null = null, explode = 0, geometry?: Body[]): Placement {
  const nodes = flatten(a)
  const live = geometry ? refreshJoints(a.joints, geometry) : { joints: a.joints, errors: {} }
  const solve = solveAssembly({ nodes, joints: live.joints, links: a.links }, drive)
  const byId = occurrenceMap({ nodes })
  const over: Record<string, Mat4> = { ...solve.over }
  if (activeOcc && byId.has(activeOcc)) over[activeOcc] = identity()
  const steps: ExplodeStep[] = a.explode.steps
  const offsets = explode > 0 && steps.length ? explodeOffsets(nodes, steps, explode) : {}
  const memo: Record<string, Mat4> = {}
  const worlds: Record<string, Mat4> = {}
  for (const n of nodes) {
    const w = worldOf(n.id, byId, over, memo)
    const off = offsets[n.id]
    worlds[n.id] = off ? multiply(translation(off), w) : w
  }
  return { solve, frameErrors: live.errors, nodes, worlds }
}
