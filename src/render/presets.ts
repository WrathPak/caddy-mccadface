/** The material library: physically based presets that need no files and no network. Pure data, shared by the viewport, the renderers and the tests. */

export type ProceduralTexture = 'wood' | 'carbon'

export interface MaterialPreset {
  id: string
  label: string
  /** one line shown under the swatch */
  desc: string
  /** base color (a tint when the preset has a procedural texture) */
  color: string
  roughness: number
  metalness: number
  /** 0..1 light passing through (glass) */
  transmission: number
  /** mm, used with transmission */
  thickness: number
  ior: number
  clearcoat: number
  clearcoatRoughness: number
  sheen: number
  sheenRoughness: number
  sheenColor: string
  iridescence: number
  /** procedural texture and its size in mm per repeat */
  texture: ProceduralTexture | null
  tileMm: number
}

const base: Omit<MaterialPreset, 'id' | 'label' | 'desc' | 'color'> = {
  roughness: 0.5, metalness: 0, transmission: 0, thickness: 0, ior: 1.45, clearcoat: 0, clearcoatRoughness: 0.1,
  sheen: 0, sheenRoughness: 0.5, sheenColor: '#ffffff', iridescence: 0, texture: null, tileMm: 30,
}

export const PRESETS: MaterialPreset[] = [
  { ...base, id: 'pla', label: 'PLA matte', desc: 'Flat, slightly grainy filament', color: '#d6d9de', roughness: 0.62, sheen: 0.15, sheenRoughness: 0.7 },
  { ...base, id: 'petg', label: 'PETG gloss', desc: 'Smooth glossy plastic', color: '#3f9ad6', roughness: 0.2, clearcoat: 0.55, clearcoatRoughness: 0.08, ior: 1.57 },
  { ...base, id: 'silk', label: 'Silk PLA', desc: 'Pearly sheen that shifts with the angle', color: '#c47ddb', roughness: 0.3, metalness: 0.3, sheen: 1, sheenRoughness: 0.25, sheenColor: '#ffd9ff', iridescence: 0.7, clearcoat: 0.3 },
  { ...base, id: 'metal', label: 'Metal', desc: 'Brushed steel', color: '#b8bdc6', roughness: 0.3, metalness: 1 },
  { ...base, id: 'wood', label: 'Wood', desc: 'Procedural oak grain', color: '#ffffff', roughness: 0.58, texture: 'wood', tileMm: 60, clearcoat: 0.15 },
  { ...base, id: 'glass', label: 'Glass', desc: 'Clear, refracting', color: '#eaf5ff', roughness: 0.02, transmission: 1, thickness: 3, ior: 1.5 },
  { ...base, id: 'rubber', label: 'Rubber', desc: 'Dull black rubber', color: '#26272a', roughness: 0.94, sheen: 0.2, sheenRoughness: 0.9 },
  { ...base, id: 'carbon', label: 'Carbon fiber', desc: 'Twill weave under clear coat', color: '#ffffff', roughness: 0.36, metalness: 0.15, texture: 'carbon', tileMm: 12, clearcoat: 1, clearcoatRoughness: 0.04 },
]

export const DEFAULT_PRESET = 'pla'
export const presetById = (id: string): MaterialPreset => PRESETS.find((p) => p.id === id) ?? PRESETS[0]

const HEX = /^#?([0-9a-f]{6})$/i
/** A valid `#rrggbb` (the leading # is optional in the input), or null for blank / anything else. */
export function parseHex(s: string | undefined): string | null {
  const m = HEX.exec((s ?? '').trim())
  return m ? '#' + m[1].toLowerCase() : null
}

/** The look of one assignment: a preset and an optional color that replaces (or, for textured presets, tints) the preset's. */
export interface AppearanceSpec { material: string; color: string }

/** The preset with the spec's color applied. */
export function effectivePreset(spec: AppearanceSpec): MaterialPreset {
  const p = presetById(spec.material)
  const c = parseHex(spec.color)
  return c ? { ...p, color: c } : p
}

export const specKey = (s: AppearanceSpec) => `${presetById(s.material).id}|${parseHex(s.color) ?? ''}`
