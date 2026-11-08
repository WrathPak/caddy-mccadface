/** The plate as the engine wants it: placed in bed coordinates, with the filament slots and painted kinds as paint codes. */
import type { FacetPaint, ObjectPaint, PlateObject as ProtocolObject } from '@muon3d/slicer-engine-protocol'
import { paintColorCode, type Placement, type PlateObject } from '../threemf'
import type { EngineObject } from './types'

/** Apply each object's placement (a translation) to its vertices. */
export function placeObjects(objects: PlateObject[], placements: Placement[]): EngineObject[] {
  return objects.map((o, i) => {
    const off = placements[i]?.offset ?? [0, 0, 0]
    const positions = new Float32Array(o.positions.length)
    for (let k = 0; k < positions.length; k += 3) {
      positions[k] = o.positions[k] + off[0]
      positions[k + 1] = o.positions[k + 1] + off[1]
      positions[k + 2] = o.positions[k + 2] + off[2]
    }
    return { name: o.name, positions, indices: o.indices, slots: o.slots, paint: o.paint, config: o.config }
  })
}

/** Facet paint for the triangles whose state is at least `min`, as the protocol takes it. Null when there is none. */
export function facetPaint(states: Uint8Array | undefined, min = 1): FacetPaint | null {
  if (!states) return null
  const triangles: number[] = []
  const ends: number[] = []
  let codes = ''
  for (let t = 0; t < states.length; t++) {
    if (states[t] < min) continue
    codes += paintColorCode(states[t])
    triangles.push(t)
    ends.push(codes.length)
  }
  if (!triangles.length) return null
  return { triangles: Uint32Array.from(triangles), codes, ends: Uint32Array.from(ends) }
}

/** Filament paint for the triangles that print in slot 2 or higher; slot 1 is the object's own filament. Null when there is none. */
export const filamentPaint = (slots: Uint8Array | undefined) => facetPaint(slots, 2)

/** The protocol's paint of one object: only the kinds that have a painted triangle (an object with none is loaded unrepaired otherwise). */
export function objectPaint(o: EngineObject): ObjectPaint | null {
  const paint: ObjectPaint = {}
  const filaments = filamentPaint(o.slots)
  const supports = facetPaint(o.paint?.supports)
  const seam = facetPaint(o.paint?.seam)
  const fuzzySkin = facetPaint(o.paint?.fuzzy)
  if (filaments) paint.filaments = filaments
  if (supports) paint.supports = supports
  if (seam) paint.seam = seam
  if (fuzzySkin) paint.fuzzySkin = fuzzySkin
  return Object.keys(paint).length ? paint : null
}

/** Engine objects as protocol objects. Meshes are copied: the host takes the buffers it is sent. */
export function toProtocolObjects(objects: EngineObject[]): ProtocolObject[] {
  return objects.map((o) => {
    const paint = objectPaint(o)
    return {
      name: o.name,
      mesh: { positions: o.positions.slice(), indices: o.indices.slice() },
      ...(o.config && Object.keys(o.config).length ? { config: o.config } : {}),
      ...(paint ? { paint } : {}),
    }
  })
}
