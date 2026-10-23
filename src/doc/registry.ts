import type { FeatureDef } from './types'

const defs = new Map<string, FeatureDef>()

/** Register a feature type (schema + compute + optional preview). Call at module load. */
export function registerFeature(def: FeatureDef) {
  defs.set(def.type, def)
}
export const getFeature = (type: string) => defs.get(type)
export const allFeatures = () => [...defs.values()]
