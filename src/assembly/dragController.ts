/** The pointer side of dragging a component: turns pointer moves into target points and hands them to the drag planner (drag.ts). */
import type { ThreeEvent } from '@react-three/fiber'
import { Plane, Raycaster, Vector2, Vector3 } from 'three'
import { useDoc } from '@/doc/store'
import type { Vec3 } from '@/kernel/types'
import { toast } from '@/ui/Modal'
import { moveOccurrence, setJointValues } from './actions'
import { dragFree, dragJoint, planDrag } from './drag'
import { lastOf, type Instance } from './instances'
import { currentPlacement } from './place'
import { useAssemblyRuntime } from './runtime'

/** True while a drag is in progress. */
let active = false
export const isDragging = () => active

export function beginDrag(e: ThreeEvent<PointerEvent>, inst: Instance) {
  const rt = useAssemblyRuntime.getState()
  const d = useDoc.getState()
  if (active) return
  if (rt.explode > 0) return void toast('Collapse the exploded view before moving components.', 'error')
  if (d.activeOcc) return void toast('Activate the root component (double-click the document in the Browser) to move components.', 'error')
  if (!inst.occ) return void toast('This body belongs to the root component. Make it a component first (Create Components from Bodies).', 'error')

  const place = currentPlacement()
  const input = { nodes: place.nodes, joints: d.assembly.joints, links: d.assembly.links }
  const grab: Vec3 = [e.point.x, e.point.y, e.point.z]
  const plan = planDrag(input, place.solve, inst.occ, grab)
  if (plan.kind === 'blocked') return void toast(plan.reason, 'error')

  const camera = e.camera
  const el = e.nativeEvent.target as HTMLElement
  const rect = el.getBoundingClientRect()
  // the grabbed point follows the pointer on the plane through it that faces the camera
  const normal = camera.getWorldDirection(new Vector3()).normalize()
  const plane = new Plane().setFromNormalAndCoplanarPoint(normal, new Vector3(...grab))
  const ray = new Raycaster()
  const at = (ev: PointerEvent): Vec3 | null => {
    ray.setFromCamera(new Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1), camera)
    const hit = ray.ray.intersectPlane(plane, new Vector3())
    return hit ? [hit.x, hit.y, hit.z] : null
  }
  const base = rt.drive

  active = true
  document.body.style.cursor = 'grabbing'
  const move = (ev: PointerEvent) => {
    const t = at(ev)
    if (!t) return
    if (plan.kind === 'joint') {
      const next = dragJoint(input, plan, t, base)
      useAssemblyRuntime.setState({ drive: { ...base, ...next } })
    } else {
      useAssemblyRuntime.getState().setFreeMove({ occ: lastOf(plan.unit), transform: dragFree(plan, t) })
    }
  }
  const up = () => {
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', up, true)
    active = false
    document.body.style.cursor = ''
    const r = useAssemblyRuntime.getState()
    if (plan.kind === 'joint') {
      // keep what the solver ended with (loops move several joints), as one undo step
      const values = currentPlacement().solve.values
      const changed: Record<string, Record<string, number>> = {}
      for (const j of useDoc.getState().assembly.joints) {
        const v = values[j.id]
        if (v && Object.keys(v).some((k) => Math.abs((j.values[k] ?? 0) - v[k]) > 1e-9)) changed[j.id] = v
      }
      r.clearDrive()
      if (Object.keys(changed).length) setJointValues(changed, 'Move component')
    } else if (r.freeMove) {
      const t = r.freeMove
      r.setFreeMove(null)
      moveOccurrence(plan.unit, t.transform)
    }
  }
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
}
