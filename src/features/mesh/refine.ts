/** Mesh refinement presets (chord deviation and angle) for Convert to Mesh and for export. */
import type { ParamDef, ParamValues } from '@/ui/schema'

export const REFINE = { coarse: { tol: 0.1, ang: 0.5 }, medium: { tol: 0.02, ang: 0.1 }, fine: { tol: 0.005, ang: 0.05 } } as const

/** The dialog fields: a Refinement choice and, for Custom, the surface deviation and the angle. `visible` hides all of them when false. */
export function refinementParams(visible?: (v: ParamValues) => boolean): ParamDef[] {
  const shown = (extra: (v: ParamValues) => boolean) => (v: ParamValues) => (visible ? visible(v) : true) && extra(v)
  return [
    {
      type: 'enum', key: 'refinement', label: 'Refinement', display: 'segmented', default: 'medium', visibleWhen: shown(() => true),
      help: 'How finely curved surfaces are cut into triangles. Coarse is light and faceted, Fine follows curves closely (and makes a bigger file), Custom sets the numbers yourself.',
      options: [{ value: 'coarse', label: 'Coarse' }, { value: 'medium', label: 'Medium' }, { value: 'fine', label: 'Fine' }, { value: 'custom', label: 'Custom' }],
    },
    { type: 'number', key: 'deviation', label: 'Surface deviation', unit: 'mm', min: 0.0005, step: 0.005, default: 0.02, help: 'How far a flat triangle may stray from the true curved surface, in mm. Smaller gives more triangles.', visibleWhen: shown((v) => v.refinement === 'custom') },
    { type: 'number', key: 'angleDeg', label: 'Angle tolerance', unit: 'deg', min: 0.5, max: 45, step: 0.5, default: 5.7, help: 'The most two neighbouring triangles may bend away from each other on a curve, in degrees. Smaller gives more triangles.', visibleWhen: shown((v) => v.refinement === 'custom') },
  ]
}

/** Chord tolerance (mm) and angle (radians) the values ask for. */
export function refinement(p: ParamValues): { tol: number; ang: number } {
  const r = (p.refinement as string | undefined) ?? 'medium'
  if (r === 'custom') return { tol: Math.max(0.0005, (p.deviation as number) ?? 0.02), ang: (Math.max(0.5, (p.angleDeg as number) ?? 5.7) * Math.PI) / 180 }
  return REFINE[r as keyof typeof REFINE] ?? REFINE.medium
}
