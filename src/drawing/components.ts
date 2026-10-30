/** What a drawing can show: the model's parts (placed components of an assembly, or the bodies of a plain part), and the parts list built from them. */
import { flatten, expandInstances, ownerOf, placeAssembly, type Instance } from '@/assembly/instances'
import { isIdentity } from '@/assembly/matrix'
import { useAssemblyRuntime } from '@/assembly/runtime'
import { ROOT, type AssemblyData } from '@/assembly/types'
import { useDoc } from '@/doc/store'
import type { Body } from '@/kernel/types'
import type { ViewItem } from './types'

export interface Component {
  /** stable key: the same for equal parts so they are counted together. `def:<id>` for a component of an assembly (saved in balloons) */
  key: string
  name: string
  items: ViewItem[]
  /** how many of them the model holds */
  qty: number
  /** the Material and Description the component was given (empty when it has none) */
  material: string
  description: string
}

/** What the parts list needs from the document, so the grouping can be tested without the stores. */
export interface BomInput {
  assembly: Pick<AssemblyData, 'components' | 'occurrences' | 'bodyOwner'>
  geometry: Body[]
  bodyNames: Record<string, string>
}

const isPartBody = (b: Body) => b.kind === 'brep' && !b.surface

const volumeOf = (b: Body): number => {
  const p = b.mesh.positions, ix = b.mesh.indices
  let v = 0
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, c = ix[t + 1] * 3, d = ix[t + 2] * 3
    v += (p[a] * (p[c + 1] * p[d + 2] - p[c + 2] * p[d + 1]) - p[a + 1] * (p[c] * p[d + 2] - p[c + 2] * p[d]) + p[a + 2] * (p[c] * p[d + 1] - p[c + 1] * p[d])) / 6
  }
  return Math.abs(v)
}

/**
 * The bill of materials of a document, one row per distinct part.
 * - A body of the root component is a part by itself; bodies with the same name and volume are one part with a quantity.
 * - A component of an assembly is one part, counted once per placed instance. A component that only holds other components is not
 *   a row: what is inside it is counted, once per copy of it.
 *   Components with the same name and the same bodies are one row, whichever definition they come from.
 * Root bodies come first, then the components in the order of the tree.
 */
export function bomOf(inp: BomInput): Component[] {
  const { assembly, geometry, bodyNames } = inp
  const bodies = geometry.filter(isPartBody)
  const nameOf = (b: Body) => bodyNames[b.id] ?? b.name
  const rows = new Map<string, Component>()

  for (const b of bodies) {
    if (ownerOf(b, assembly) !== ROOT) continue
    const key = `${nameOf(b)}|${volumeOf(b).toFixed(2)}`
    const row = rows.get(key)
    if (row) { row.qty++; row.items.push({ bodyId: b.id }) }
    else rows.set(key, { key, name: nameOf(b), items: [{ bodyId: b.id }], qty: 1, material: '', description: '' })
  }

  const byDef = new Map<string, Body[]>()
  for (const b of bodies) {
    const d = ownerOf(b, assembly)
    if (d !== ROOT) (byDef.get(d) ?? byDef.set(d, []).get(d)!).push(b)
  }
  const perDef = new Map<string, { count: number; first: string }>()
  for (const n of flatten(assembly)) {
    const e = perDef.get(n.component)
    if (e) e.count++
    else perDef.set(n.component, { count: 1, first: n.id })
  }
  const bySig = new Map<string, Component>()
  for (const [def, info] of perDef) {
    const own = byDef.get(def)
    if (!own?.length) continue
    const meta = assembly.components.find((c) => c.id === def)
    const name = meta?.name ?? def
    const sig = `${name}|${own.length}|${own.map((b) => volumeOf(b).toFixed(2)).sort().join(',')}`
    const row = bySig.get(sig)
    if (row) {
      row.qty += info.count
      if (!row.material) row.material = meta?.material ?? ''
      if (!row.description) row.description = meta?.description ?? ''
      continue
    }
    const comp: Component = { key: 'def:' + def, name, items: own.map((b) => ({ bodyId: b.id, occ: info.first })), qty: info.count, material: meta?.material ?? '', description: meta?.description ?? '' }
    bySig.set(sig, comp)
    rows.set(comp.key, comp)
  }
  return [...rows.values()]
}

/** The parts of the model now. */
export function listComponents(): Component[] {
  const d = useDoc.getState()
  return bomOf({ assembly: d.assembly, geometry: d.geometry, bodyNames: d.bodyNames })
}

// ---------------------------------------------------------------- where the parts are

let poseCache: { key: unknown[]; byKey: Map<string, Instance> } | null = null

/** Every placed body of the model with its pose (joints solved as they stand, nothing exploded, no component pulled to the origin). */
function placed(): Map<string, Instance> {
  const d = useDoc.getState(), r = useAssemblyRuntime.getState()
  const key = [d.assembly, d.geometry, r.drive]
  if (poseCache && poseCache.key.every((v, i) => v === key[i])) return poseCache.byKey
  const pl = placeAssembly(d.assembly, r.drive, null, 0, d.geometry)
  const byKey = new Map<string, Instance>()
  for (const i of expandInstances(d.assembly, d.geometry, pl.worlds)) byKey.set(i.key, i)
  poseCache = { key, byKey }
  return byKey
}

const keyOf = (item: ViewItem) => `${item.occ ?? ''}|${item.bodyId}`

/** False when the instance an item stands for is gone from the model. */
export function itemExists(item: ViewItem): boolean {
  return !item.occ || placed().has(keyOf(item))
}

/** Column-major 4x4 that places an item in the model, or undefined when it sits where its body is. */
export function itemMatrix(item: ViewItem): number[] | undefined {
  const i = placed().get(keyOf(item))
  return i && !isIdentity(i.world, 1e-9) ? i.world : undefined
}

/** Bodies of the model a drawing can show. */
export function drawableBodies(): Body[] {
  return useDoc.getState().geometry.filter(isPartBody)
}

/** Every placed instance of every solid body: what the whole model looks like. */
function allItems(): ViewItem[] {
  return [...placed().values()].filter((i) => isPartBody(i.body)).map((i) => (i.occ ? { bodyId: i.body.id, occ: i.occ } : { bodyId: i.body.id }))
}

/** One view item per body or per component, for the base view dialog: value is `all`, `body:<id>`, or a component key. */
export function viewChoices(): { value: string; label: string }[] {
  const comps = listComponents()
  const out = [{ value: 'all', label: 'Everything' }]
  for (const c of comps) out.push({ value: 'comp:' + c.key, label: c.qty > 1 ? `${c.name} (${c.qty})` : c.name })
  return out
}

export function itemsFor(choice: string): ViewItem[] {
  if (choice === 'all') return allItems()
  const key = choice.replace(/^comp:/, '')
  const c = listComponents().find((x) => x.key === key)
  if (!c) return []
  // equal root bodies are one part drawn once; a component is drawn with all its bodies
  return key.startsWith('def:') ? c.items : c.items.slice(0, 1)
}
