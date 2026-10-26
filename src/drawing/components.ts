/** What a drawing can show: the model's components (or, in a plain part, its bodies), and the parts list built from them. */
import { useDoc } from '@/doc/store'
import type { Body } from '@/kernel/types'
import type { ViewItem } from './types'

export interface Component {
  /** stable key: the same for equal parts so they are counted together */
  key: string
  name: string
  items: ViewItem[]
  /** how many of them the model holds */
  qty: number
}

/** Column-major 4x4 that places an item in the model, or undefined when it sits where its body is. */
export function itemMatrix(_item: ViewItem): number[] | undefined {
  return undefined
}

/** Bodies of the model a drawing can show. */
export function drawableBodies(): Body[] {
  return useDoc.getState().geometry.filter((b) => b.kind === 'brep')
}

const volumeOf = (b: Body): number => {
  const p = b.mesh.positions, ix = b.mesh.indices
  let v = 0
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, c = ix[t + 1] * 3, d = ix[t + 2] * 3
    v += (p[a] * (p[c + 1] * p[d + 2] - p[c + 2] * p[d + 1]) - p[a + 1] * (p[c] * p[d + 2] - p[c + 2] * p[d]) + p[a + 2] * (p[c] * p[d + 1] - p[c + 1] * p[d])) / 6
  }
  return Math.abs(v)
}

const bodyName = (b: Body) => useDoc.getState().bodyNames[b.id] ?? b.name

/**
 * The parts of the model. Bodies with the same name and volume are one part with a quantity.
 */
export function listComponents(): Component[] {
  const out = new Map<string, Component>()
  for (const b of drawableBodies()) {
    const name = bodyName(b)
    const key = `${name}|${volumeOf(b).toFixed(2)}`
    const c = out.get(key)
    if (c) { c.qty++; c.items.push({ bodyId: b.id }) }
    else out.set(key, { key, name, items: [{ bodyId: b.id }], qty: 1 })
  }
  return [...out.values()]
}

/** One view item per body or per component, for the base view dialog: value is `all`, `body:<id>`, or a component key. */
export function viewChoices(): { value: string; label: string }[] {
  const comps = listComponents()
  const out = [{ value: 'all', label: 'Everything' }]
  for (const c of comps) out.push({ value: 'comp:' + c.key, label: c.qty > 1 ? `${c.name} (${c.qty})` : c.name })
  return out
}

export function itemsFor(choice: string): ViewItem[] {
  if (choice === 'all') return drawableBodies().map((b) => ({ bodyId: b.id }))
  const key = choice.replace(/^comp:/, '')
  const c = listComponents().find((x) => x.key === key)
  return c ? c.items.slice(0, 1) : []
}
