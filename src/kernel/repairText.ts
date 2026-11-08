/** The sentence a Repair step reports (pure, so the page can use it without loading the mesh ops). */
import type { RepairReport } from './mesh-ops'

export function describeRepair(r: RepairReport): string {
  const bits: string[] = []
  if (r.type === 'wrap' || r.type === 'rebuild') bits.push(`${r.type === 'wrap' ? 'wrapped' : 'rebuilt'} as a closed mesh on a ${+(r.voxel ?? 0).toFixed(3)} mm grid`)
  if (r.holesFilled) bits.push(`closed ${r.holesFilled} hole${r.holesFilled > 1 ? 's' : ''}`)
  if (r.welded) bits.push(`welded ${r.welded} vertices`)
  if (r.facesFlipped) bits.push(`flipped ${r.facesFlipped} triangles`)
  if (r.shellsRemoved) bits.push(`removed ${r.shellsRemoved} small shell${r.shellsRemoved > 1 ? 's' : ''}`)
  if (r.degenerate + r.duplicates) bits.push(`dropped ${r.degenerate + r.duplicates} degenerate or duplicate triangles`)
  return bits.length ? 'Repair: ' + bits.join(', ') : 'Repair: nothing needed fixing'
}
