import type { FeatureDef } from './types'

const defs = new Map<string, FeatureDef>()

/** Register a feature type (schema + compute + optional preview). Call at module load. */
export function registerFeature(def: FeatureDef) {
  defs.set(def.type, def)
}
/** Take a feature type away again (a plugin that was switched off). Features of that type in a document then report an unknown type. */
export const unregisterFeature = (type: string) => void defs.delete(type)
export const getFeature = (type: string) => defs.get(type)
export const allFeatures = () => [...defs.values()]
