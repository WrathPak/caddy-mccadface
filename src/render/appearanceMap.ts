/** Which look every body and face has: the Appearance features of the timeline resolved against the current bodies. */
import { RefReport, decodeRef, resolveFace } from '@/doc/refs'
import { resolveParams } from '@/doc/params'
import type { Feature } from '@/doc/types'
import type { Body } from '@/kernel/types'
import type { ParamSchema } from '@/ui/schema'
import { DEFAULT_PRESET, PRESETS, type AppearanceSpec } from './presets'

export const appearanceSchema: ParamSchema = {
  id: 'appearance',
  title: 'Appearance',
  params: [
    {
      type: 'selection-ref', key: 'targets', label: 'Bodies or faces', accepts: ['body', 'face'], multiple: true, required: true, pick: true, default: [],
      help: 'What gets the material: whole bodies, or single faces. Faces keep their material when the model is edited.',
    },
    {
      type: 'enum', key: 'material', label: 'Material', display: 'select', default: DEFAULT_PRESET,
      options: PRESETS.map((p) => ({ value: p.id, label: p.label, desc: p.desc })),
      help: 'The material from the library. Rendering and the viewport both show it.',
    },
    {
      type: 'text', key: 'color', label: 'Color', default: '', placeholder: 'Preset color',
      help: 'A color as #rrggbb. Leave it blank to use the color of the material. On wood and carbon fiber it tints the pattern.',
    },
  ],
}

export interface BodyAppearance {
  /** applies to every face without its own entry */
  body: AppearanceSpec | null
  faces: Map<number, AppearanceSpec>
}
export type AppearanceMap = Map<string, BodyAppearance>

const entryOf = (map: AppearanceMap, id: string): BodyAppearance => {
  let e = map.get(id)
  if (!e) map.set(id, (e = { body: null, faces: new Map() }))
  return e
}

/** Give the bodies / faces named by `targets` this look. A body assignment replaces the faces assigned before it. Returns how many targets were found. */
export function applyAppearance(map: AppearanceMap, bodies: Body[], targets: string[], spec: AppearanceSpec, report?: RefReport): number {
  let found = 0
  for (const t of targets) {
    const ref = decodeRef(t)
    if (!ref) { report?.lost.set(t, 'A reference could not be read'); continue }
    if (ref.kind === 'body') {
      const body = bodies.find((b) => b.id === ref.bodyId)
      if (!body) { report?.lost.set(t, 'The body this material was on no longer exists'); continue }
      const e = entryOf(map, body.id)
      e.body = spec
      e.faces.clear()
      found++
    } else if (ref.kind === 'face') {
      const res = resolveFace(ref, bodies, report)
      if (!res) continue
      entryOf(map, res.body.id).faces.set(res.index, spec)
      found++
    }
  }
  return found
}

/** Everything the active Appearance features assign, resolved against the final bodies (later features win). */
export function computeAppearanceMap(features: Feature[], rollback: number, bodies: Body[]): AppearanceMap {
  const map: AppearanceMap = new Map()
  for (let i = 0; i < Math.min(rollback, features.length); i++) {
    const f = features[i]
    if (f.type !== 'appearance' || f.suppressed) continue
    try {
      const p = resolveParams(appearanceSchema, f.params)
      applyAppearance(map, bodies, p.targets as string[], { material: String(p.material), color: String(p.color ?? '') })
    } catch { /* an invalid appearance feature shows its error on the timeline */ }
  }
  return map
}

/** The spec for a face of a body (its own, else the body's), or null when it has none. */
export function specForFace(e: BodyAppearance | undefined, face: number): AppearanceSpec | null {
  return e?.faces.get(face) ?? e?.body ?? null
}
