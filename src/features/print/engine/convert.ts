/** The plate as the engine wants it: placed in bed coordinates, with the filament slots as paint codes. */
import type { FacetPaint, PlateObject as ProtocolObject } from '@muon3d/slicer-engine-protocol'
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
    return { name: o.name, positions, indices: o.indices, slots: o.slots }
  })
}

/** Filament paint for the triangles that print in slot 2 or higher; slot 1 is the object's own filament. Null when there is none. */
export function filamentPaint(slots: Uint8Array | undefined): FacetPaint | null {
  if (!slots) return null
  const triangles: number[] = []
  const ends: number[] = []
  let codes = ''
  for (let t = 0; t < slots.length; t++) {
    if (slots[t] < 2) continue
    codes += paintColorCode(slots[t])
    triangles.push(t)
    ends.push(codes.length)
  }
  if (!triangles.length) return null
  return { triangles: Uint32Array.from(triangles), codes, ends: Uint32Array.from(ends) }
}

/** Engine objects as protocol objects. Meshes are copied: the host takes the buffers it is sent. */
export function toProtocolObjects(objects: EngineObject[]): ProtocolObject[] {
  return objects.map((o) => {
    const filaments = filamentPaint(o.slots)
    return {
      name: o.name,
      mesh: { positions: o.positions.slice(), indices: o.indices.slice() },
      ...(filaments ? { paint: { filaments } } : {}),
    }
  })
}
