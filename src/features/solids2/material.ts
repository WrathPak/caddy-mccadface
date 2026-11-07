/** Physical Material: a material (with a density) for bodies. The density drives the mass and centre of gravity that Measure shows. */
import { Cube } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { bodyIdsOf } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { Feature } from '@/doc/types'
import type { Body, Vec3 } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamSchema } from '@/ui/schema'

/** Densities in g/cm3. */
export const MATERIALS: { id: string; label: string; density: number }[] = [
  { id: 'steel', label: 'Steel (mild)', density: 7.85 },
  { id: 'stainless', label: 'Stainless steel', density: 8.0 },
  { id: 'aluminium', label: 'Aluminium', density: 2.7 },
  { id: 'brass', label: 'Brass', density: 8.5 },
  { id: 'copper', label: 'Copper', density: 8.96 },
  { id: 'titanium', label: 'Titanium', density: 4.43 },
  { id: 'abs', label: 'ABS plastic', density: 1.04 },
  { id: 'pla', label: 'PLA plastic', density: 1.24 },
  { id: 'petg', label: 'PETG plastic', density: 1.27 },
  { id: 'nylon', label: 'Nylon', density: 1.15 },
  { id: 'oak', label: 'Oak (wood)', density: 0.75 },
  { id: 'pine', label: 'Pine (wood)', density: 0.5 },
  { id: 'glass', label: 'Glass', density: 2.5 },
  { id: 'rubber', label: 'Rubber', density: 1.1 },
  { id: 'concrete', label: 'Concrete', density: 2.4 },
  { id: 'water', label: 'Water', density: 1.0 },
  { id: 'custom', label: 'Custom density', density: 1.0 },
]

export const materialSchema: ParamSchema = {
  id: 'material',
  title: 'Physical Material',
  params: [
    { type: 'selection-ref', key: 'bodyIds', help: 'The bodies made of this material. Click them in the viewport or the Browser.', label: 'Bodies', accepts: ['body'], multiple: true, required: true, pick: true, default: [] },
    { type: 'preset', key: 'material', help: 'The material. Choosing one fills in its density; you can still change the density below.', label: 'Material', presets: MATERIALS.map((m) => ({ id: m.id, label: `${m.label}  (${m.density} g/cm³)`, values: { density: m.density } })), default: 'steel' },
    { type: 'number', key: 'density', help: 'Mass of one cubic centimetre of the material, in grams (steel is 7.85, water is 1).', label: 'Density', unit: '', min: 0.001, step: 0.05, default: 7.85 },
  ],
}

registerFeature({
  type: 'material',
  label: 'Physical Material',
  icon: Cube,
  schema: materialSchema,
  // it changes no geometry: the bodies keep their shape and Measure reads the density from this step
  async compute(ctx, p) {
    const ids = bodyIdsOf(p.bodyIds as string[])
    if (!ids.length) throw new Error('Select the bodies to give a material')
    if (ids.some((id) => !ctx.body(id))) throw new Error('A body no longer exists. Pick it again.')
    return {}
  },
})

export interface BodyMaterial { id: string; label: string; density: number }

/** The material set for a body by the steps before the rollback marker (the latest one wins), or null. */
export function materialOf(bodyId: string, features: Feature[] = useDoc.getState().features, rollback = useDoc.getState().rollback): BodyMaterial | null {
  let found: BodyMaterial | null = null
  features.forEach((f, i) => {
    if (f.type !== 'material' || f.suppressed || i >= rollback) return
    if (!bodyIdsOf((f.params.bodyIds as string[]) ?? []).includes(bodyId)) return
    const id = (f.params.material as string) ?? 'custom'
    const m = MATERIALS.find((x) => x.id === id)
    found = { id, label: m?.label ?? 'Custom density', density: (f.params.density as number) ?? m?.density ?? 1 }
  })
  return found
}

export interface Physical { volume: number; /** surface area, mm2 */ area: number; centroid: Vec3 }

/** Volume, surface area and centre of gravity of a closed mesh (signed tetrahedra about the origin). */
export function physicalOf(b: Body): Physical {
  const p = b.mesh.positions, ix = b.mesh.indices
  let v = 0, area = 0
  const c: Vec3 = [0, 0, 0]
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, bb = ix[t + 1] * 3, cc = ix[t + 2] * 3
    const ax = p[a], ay = p[a + 1], az = p[a + 2], bx = p[bb], by = p[bb + 1], bz = p[bb + 2], cx = p[cc], cy = p[cc + 1], cz = p[cc + 2]
    const d = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    v += d
    c[0] += d * (ax + bx + cx) / 4
    c[1] += d * (ay + by + cy) / 4
    c[2] += d * (az + bz + cz) / 4
    const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az
    area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2
  }
  const vol = Math.abs(v)
  const k = v !== 0 ? 1 / v : 0
  return { volume: vol, area, centroid: [c[0] * k, c[1] * k, c[2] * k] }
}

/** Mass in grams of a volume in mm3 and a density in g/cm3. */
export const massOf = (volumeMm3: number, density: number) => (volumeMm3 / 1000) * density

export function startMaterial() {
  const sel = useUi.getState().selection
  const geometry = useDoc.getState().geometry
  let ids = [...new Set(sel.filter((r) => r.kind === 'body' || r.kind === 'face' || r.kind === 'edge' || r.kind === 'mesh').map((r) => r.id))].filter((id) => geometry.some((b) => b.id === id))
  if (!ids.length && geometry.length === 1) ids = [geometry[0].id]
  createFeature('material', { bodyIds: ids }, 'solid.material')
}
