import type { Icon } from '@phosphor-icons/react'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import type { Body } from '@/kernel/types'
import type { KernelClient } from '@/kernel/client'
import type { AssemblyData } from '@/assembly/types'

export type FeatureState = 'ok' | 'warning' | 'error' | 'suppressed'

/** A feature instance in the timeline. `params` may hold expression strings for number params. */
export interface Feature {
  id: string
  type: string
  name: string
  state: FeatureState
  error?: string
  /** non-fatal problem: the feature built, but something it depends on is off (state 'warning') */
  warning?: string
  /** stored refs (as they appear in `params`) the last regeneration had to re-bind by position, or could not resolve */
  reboundRefs?: string[]
  lostRefs?: string[]
  suppressed: boolean
  params: ParamValues
  /** the component this feature belongs to (its timeline section); absent means the root component */
  component?: string
}

export interface UserParam { name: string; expr: string }
/** A named set of values for user parameters (sizes S / M / L): `values` maps a parameter name to its expression in that configuration. */
export interface Config { name: string; values: Record<string, string> }

/** Everything undo/redo and save/load care about. */
export interface DocData {
  name: string
  features: Feature[]
  rollback: number
  userParams: UserParam[]
  bodyNames: Record<string, string>
  /** configurations (table of parameter sets) and the one in effect (null: the parameters as they are) */
  configs: Config[]
  activeConfig: string | null
  /** components, their occurrences, joints, links, explode steps and the motion study (see assembly/types.ts) */
  assembly: AssemblyData
}

export interface FeatureCtx {
  feature: { id: string; type: string; name: string }
  /** bodies alive before this feature (output of the previous feature) */
  bodies: Body[]
  body(id: string): Body | undefined
  /** worker API (heavy geometry work happens there) */
  kernel: KernelClient
  /** bytes stored in the document (import sources) */
  blob(id: string): Uint8Array | undefined
  /** `${featureId}` for n = 0/undefined, else `${featureId}.${n}` */
  newBodyId(n?: number): string
  /** the `data` a previous feature returned (e.g. a sketch's profiles) */
  dataOf(featureId: string): unknown
  /** raw feature record by id (earlier features only is the caller's responsibility) */
  featureById(id: string): Feature | undefined
  /** the bodies right before and right after an earlier feature ran (undefined for a feature that did not run) */
  stateAround(featureId: string): { before: Body[]; after: Body[] } | undefined
}

export interface FeatureResult {
  /** bodies to add, or replace when the id already exists */
  bodies?: Body[]
  /** ids of bodies to remove */
  remove?: string[]
  /** arbitrary data for later features (read with ctx.dataOf) */
  data?: unknown
  /** non-fatal problem to show on the feature (e.g. broken references) */
  warning?: string
  /** the stored refs behind `warning` that were re-bound by position (highlighted in the Inspector) */
  reboundRefs?: string[]
  /** legacy refs that resolved, with the named version of each (the engine writes these back into the feature params) */
  upgrades?: Record<string, string>
}

export interface PreviewCtx {
  values: ParamValues
  /** push new values into the open Inspector (e.g. from an on-canvas manipulator) */
  setValues(v: ParamValues): void
}
export interface PreviewHandle {
  update(values: ParamValues): void
  dispose(): void
  /** the pointer / focus moved into a schema group that has an id */
  activeGroup?(id: string): void
}

export interface FeatureDef {
  type: string
  label: string
  icon: Icon
  schema: ParamSchema
  /** `params` arrive with number expressions resolved and defaults filled */
  compute(ctx: FeatureCtx, params: ParamValues): Promise<FeatureResult>
  /** optional live preview while the Inspector is open; may return a handle */
  preview?(ctx: PreviewCtx): PreviewHandle | void
  /** custom editor (e.g. the sketcher) used instead of the Inspector when a timeline chip is double-clicked */
  edit?(featureId: string, params: ParamValues): void
  /** true when compute() reads user parameters itself (so a parameter change must re-run it) */
  dependsOnParams?: boolean
}
