/**
 * Dragging a component in the viewport. The component moves the way its joint lets it: the values of the joint that places it are
 * adjusted until the point you grabbed is as close as it can get to the pointer. A component no joint places is moved freely,
 * a grounded one does not move at all.
 */
import type { Vec3 } from '@/kernel/types'
import { clampValue, dofsOf } from './joints'
import { identity, invert, multiply, point, sub, translation, type Mat4 } from './matrix'
import { lmSolve } from './solver'
import { occurrenceMap, solveAssembly, type DriveMap, type SolveInput, type SolveResult } from './solver'

export type DragPlan =
  | { kind: 'blocked'; reason: string }
  | { kind: 'joint'; unit: string; joint: string; grabLocal: Vec3; keys: string[] }
  | { kind: 'free'; unit: string; grabWorld: Vec3; start: Mat4; parent: Mat4 }

export function planDrag(a: SolveInput, solve: SolveResult, hit: string, grabWorld: Vec3): DragPlan {
  const byId = occurrenceMap(a)
  let cur: string | null = hit
  const chain: string[] = []
  while (cur && byId.has(cur)) { chain.push(cur); cur = byId.get(cur)!.parent }
  for (const c of chain) {
    if (byId.get(c)!.grounded) return { kind: 'blocked', reason: 'This component is grounded, so it does not move. Unground it first.' }
    if (solve.placed.has(c)) {
      const j = a.joints.find((x) => x.id === solve.via[c])
      if (!j) return { kind: 'blocked', reason: 'Its joint could not be found.' }
      const keys = dofsOf(j.type).map((d) => d.key)
      if (!keys.length) return { kind: 'blocked', reason: 'A rigid joint holds this component in place. Use the Drive Joints panel on another joint, or remove the joint.' }
      const driven = new Set(a.links.map((l) => l.b.joint + ':' + l.b.key))
      if (keys.every((k) => driven.has(j.id + ':' + k))) return { kind: 'blocked', reason: 'A motion link drives this joint. Drag the joint it follows instead.' }
      return { kind: 'joint', unit: c, joint: j.id, grabLocal: point(invert(solve.worlds[c]), grabWorld), keys }
    }
  }
  const par = byId.get(hit)?.parent
  return { kind: 'free', unit: hit, grabWorld, start: solve.worlds[hit], parent: par ? solve.worlds[par] : identity() }
}

/** The values of the planned joint that bring the grabbed point nearest to `target`. */
export function dragJoint(a: SolveInput, plan: Extract<DragPlan, { kind: 'joint' }>, target: Vec3, drive: DriveMap = {}): DriveMap {
  const j = a.joints.find((x) => x.id === plan.joint)!
  const start = solveAssembly(a, drive).values[j.id]
  const others = Object.fromEntries(Object.entries(drive).filter(([id]) => id !== j.id))
  const make = (u: number[]) => ({ ...others, [j.id]: Object.fromEntries(plan.keys.map((k, i) => [k, clampValue(j, k, u[i])])) })
  const residual = (u: number[]): number[] => {
    const w = solveAssembly(a, make(u)).worlds[plan.unit]
    const p = point(w, plan.grabLocal)
    return [p[0] - target[0], p[1] - target[1], p[2] - target[2]]
  }
  const u = lmSolve(residual, plan.keys.map((k) => start[k]), { iterations: 60, tol: 1e-5, clamp: (v, i) => clampValue(j, plan.keys[i], v) })
  return make(u)
}

/** The occurrence transform that carries a freely moved component so the grabbed point lands on `target`. */
export function dragFree(plan: Extract<DragPlan, { kind: 'free' }>, target: Vec3): Mat4 {
  const delta = sub(target, plan.grabWorld)
  return multiply(invert(plan.parent), multiply(translation(delta), plan.start))
}
