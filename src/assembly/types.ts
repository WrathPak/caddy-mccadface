/**
 * The assembly part of a document: a tree of components (definitions) and their occurrences (placed instances), the joints
 * between occurrences, motion links, the explode presentation and the motion study. Everything here is saved in the .caddy.
 *
 * A component DEFINITION owns bodies, sketches and construction geometry: the timeline features whose `component` is its id.
 * An OCCURRENCE puts a definition inside another definition (`parent` is that definition, the root for a top level one) at a
 * transform. Several occurrences can share one definition, so they share its geometry and everything inside it. What the viewport
 * and the joints deal with is the INSTANCE of an occurrence: its path, the occurrence ids from the top down joined by '/'
 * (the same occurrence inside two instances of its parent is two instances, with two paths).
 */
import type { Vec3 } from '@/kernel/types'
import type { Frame, Mat4 } from './matrix'

/** Id of the root component, which every document has. */
export const ROOT = 'root'

export interface ComponentDef {
  id: string
  name: string
  /** set for a component that comes from another .caddy file (see external.ts) */
  external?: string
}

export interface Occurrence {
  id: string
  name: string
  component: string
  /** the component definition this occurrence sits in (the root for a top level one) */
  parent: string
  /** placement relative to the space of the component it sits in (identity for a fresh component) */
  transform: Mat4
  grounded?: boolean
}

export type JointType = 'rigid' | 'revolute' | 'slider' | 'cylindrical' | 'pinSlot' | 'planar' | 'ball'

/** What a joint origin was snapped to, so it can be found again after the geometry changes. */
export type SnapKind = 'face' | 'edgeMid' | 'circle' | 'vertex'
export interface SnapSpec {
  kind: SnapKind
  /** encoded face / edge / vertex ref (doc/refs.ts), which carries the persistent name and the component path */
  ref: string
}

export interface JointOrigin {
  /** the instance (occurrence path) this origin sits on */
  occ: string
  /** the frame in the occurrence's component space (the last position the snap resolved to) */
  frame: Frame
  snap?: SnapSpec
}

export interface Limit { enabled: boolean; min: number; max: number; rest: number }

export interface Joint {
  id: string
  name: string
  type: JointType
  /** origin on the first occurrence; the second occurrence moves relative to it */
  a: JointOrigin
  b: JointOrigin
  flip: boolean
  /** offset of the joint frame (mm) and an extra turn about its axis (deg) */
  offset: Vec3
  angle: number
  /** current value of every degree of freedom (mm or deg), by key (see joints.ts) */
  values: Record<string, number>
  limits: Record<string, Limit>
  suppressed?: boolean
  /** made by As-built Joint: the components were left where they are */
  asBuilt?: boolean
}

/** value(b) = value(a) * ratio: gears, rack and pinion, screws. */
export interface MotionLink {
  id: string
  name: string
  a: { joint: string; key: string }
  b: { joint: string; key: string }
  ratio: number
}

export interface ExplodeStep {
  id: string
  name: string
  /** instances (occurrence paths) that move in this step */
  occs: string[]
  /** world direction (need not be unit) and distance (mm) */
  direction: Vec3
  distance: number
  trail: boolean
}

export interface Keyframe { t: number; v: number }
export interface MotionTrack { joint: string; key: string; frames: Keyframe[] }
export interface MotionStudy { duration: number; loop: boolean; tracks: MotionTrack[] }

/** A component that lives in another file. `blob` holds the .caddy bytes this document last read. */
export interface ExternalRef {
  id: string
  fileName: string
  blob: string
  /** linked: re-read from its file when it changes; embedded: a copy that stays as it is */
  linked: boolean
  /** lastModified of the file when `blob` was read, and a hash of its bytes */
  stamp: number
  hash: string
}

export interface AssemblyData {
  components: ComponentDef[]
  occurrences: Occurrence[]
  joints: Joint[]
  links: MotionLink[]
  explode: { steps: ExplodeStep[] }
  motion: MotionStudy
  externals: ExternalRef[]
  /** bodies moved to another component than the one of the feature that made them (Create Components from Bodies) */
  bodyOwner: Record<string, string>
}

export const emptyMotion = (): MotionStudy => ({ duration: 4, loop: false, tracks: [] })
export const emptyAssembly = (): AssemblyData => ({
  components: [{ id: ROOT, name: 'Root' }],
  occurrences: [],
  joints: [],
  links: [],
  explode: { steps: [] },
  motion: emptyMotion(),
  externals: [],
  bodyOwner: {},
})

/** Fills in whatever a document saved before assemblies (or by an older build) lacks. */
export function normalizeAssembly(a: Partial<AssemblyData> | undefined): AssemblyData {
  const e = emptyAssembly()
  if (!a) return e
  const components = a.components?.some((c) => c.id === ROOT) ? a.components : [e.components[0], ...(a.components ?? [])]
  return {
    components,
    occurrences: a.occurrences ?? [],
    joints: a.joints ?? [],
    links: a.links ?? [],
    explode: { steps: a.explode?.steps ?? [] },
    motion: { ...emptyMotion(), ...(a.motion ?? {}), tracks: a.motion?.tracks ?? [] },
    externals: a.externals ?? [],
    bodyOwner: a.bodyOwner ?? {},
  }
}

/** True when the document has anything beyond the single implicit root component. */
export const isAssembly = (a: AssemblyData) => a.occurrences.length > 0
