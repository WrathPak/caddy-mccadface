/** Placement of the assembly as the viewport and the tools see it: joints solved, the active component at its own origin, explode applied. */
import { useMemo } from 'react'
import { useDoc, activeDefId } from '@/doc/store'
import { useUi } from '@/store/ui'
import { expandInstances, placeAssembly, type Instance, type Placement } from './instances'
import { isIdentity } from './matrix'
import { useAssemblyRuntime } from './runtime'
import type { AssemblyData } from './types'
import { ROOT } from './types'

let last: { key: unknown[]; value: Placement } | null = null

function placementFor(assembly: AssemblyData, drive: ReturnType<typeof useAssemblyRuntime.getState>['drive'], active: string | null, explode: number): Placement {
  const key = [assembly, drive, active, explode]
  if (last && last.key.every((v, i) => v === key[i])) return last.value
  const value = placeAssembly(assembly, drive, active, explode)
  last = { key, value }
  return value
}

export function currentPlacement(): Placement {
  const d = useDoc.getState(), r = useAssemblyRuntime.getState()
  return placementFor(d.assembly, r.drive, d.activeOcc, r.explode)
}
export function usePlacement(): Placement {
  const assembly = useDoc((s) => s.assembly)
  const active = useDoc((s) => s.activeOcc)
  const drive = useAssemblyRuntime((s) => s.drive)
  const explode = useAssemblyRuntime((s) => s.explode)
  return useMemo(() => placementFor(assembly, drive, active, explode), [assembly, drive, active, explode])
}

export function currentInstances(): Instance[] {
  const d = useDoc.getState()
  return expandInstances(d.assembly, d.geometry, currentPlacement().worlds)
}
export function useInstances(): Instance[] {
  const geometry = useDoc((s) => s.geometry)
  const assembly = useDoc((s) => s.assembly)
  const placement = usePlacement()
  return useMemo(() => expandInstances(assembly, geometry, placement.worlds), [geometry, assembly, placement])
}

/** Whether an instance is hidden: its body, any occurrence it sits in, or (for hidden component ids) the component itself. */
export function instanceHidden(i: Instance, hidden: Record<string, true>): boolean {
  if (hidden[i.body.id]) return true
  return i.path ? i.path.split('/').some((o) => hidden[o]) : false
}

/** Dimmed while another component is being edited. */
export function instanceDimmed(i: Instance, active: string | null): boolean {
  if (!active) return false
  return !i.path.split('/').includes(active)
}

/**
 * Whether feature tools can pick this instance. They work on the geometry as the component defines it, so an instance qualifies when
 * it is part of the component being edited, or when its placement is the identity (the geometry then is where it is drawn).
 * Bodies of linked components are read only.
 */
export function instancePickable(i: Instance, state: { activeOcc: string | null; assembly: AssemblyData }): boolean {
  if (i.def.startsWith('ext:')) return false
  const active = activeDefId(state)
  if (i.def === active) return true
  return isIdentity(i.world, 1e-7)
}

export const isAssemblyDoc = (a: AssemblyData) => a.occurrences.length > 0
export const activeDefName = (a: AssemblyData, active: string | null) => {
  const def = activeDefId({ activeOcc: active, assembly: a })
  return def === ROOT ? 'Root' : a.components.find((c) => c.id === def)?.name ?? def
}
export const useActiveOcc = () => useDoc((s) => s.activeOcc)
export const useHidden = () => useUi((s) => s.hiddenIds)
