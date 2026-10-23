/** Sketch data model (plane-local 2D). Shared by the editor, the feature compute and the kernel ops. */

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]

/** Sketch plane in world space. Local y = normal x xDir. */
export interface PlaneDef { origin: Vec3; xDir: Vec3; normal: Vec3 }

/** Id of the implicit, fixed sketch origin point. */
export const ORIGIN = 'O'

export interface PointE { id: string; type: 'point'; x: number; y: number; construction?: boolean }
export interface LineE { id: string; type: 'line'; p1: string; p2: string; construction?: boolean }
export interface CircleE { id: string; type: 'circle'; c: string; r: number; construction?: boolean }
/** Counter-clockwise arc from `s` to `e` around `c`. */
export interface ArcE { id: string; type: 'arc'; c: string; s: string; e: string; construction?: boolean }
export type Entity = PointE | LineE | CircleE | ArcE

export type ConstraintType =
  | 'pointOnLine' | 'pointOnCurve' | 'onAxis' | 'midpoint'
  | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'tangent' | 'equal' | 'fix'
  | 'distance' | 'hdist' | 'vdist' | 'radius' | 'diameter' | 'angle'

export interface Constraint {
  id: string
  type: ConstraintType
  /**
   * Entity ids. pointOnLine/pointOnCurve/midpoint: [point, curve]; onAxis/fix: [point]; horizontal/vertical:
   * [line] or [pointA, pointB]; parallel/perpendicular/tangent/equal: [a, b]; distance: [pointA, pointB] or
   * [point, line]; hdist/vdist: [pointA, pointB]; radius/diameter: [circle|arc]; angle: [lineA, lineB].
   */
  refs: string[]
  axis?: 'x' | 'y'
  /** dimension value expression (may reference user parameters) and its last evaluated value (mm / deg) */
  expr?: string
  value?: number
  /** +1 / -1: orientation of the measured quantity at creation */
  sgn?: 1 | -1
  /** label / dimension line position (plane-local) */
  off?: Vec2
}

export const DIM_TYPES: ConstraintType[] = ['distance', 'hdist', 'vdist', 'radius', 'diameter', 'angle']
export const isDim = (c: Constraint) => DIM_TYPES.includes(c.type)

export interface SketchModel {
  entities: Entity[]
  constraints: Constraint[]
  next: number
}

export const emptyModel = (): SketchModel => ({ entities: [], constraints: [], next: 1 })

// ---- profiles

export type Seg =
  | { k: 'l'; a: Vec2; b: Vec2 }
  /** arc from a to b through m (centre c, radius r; ccw when traversed a -> b counter-clockwise) */
  | { k: 'a'; a: Vec2; m: Vec2; b: Vec2; c: Vec2; r: number; ccw: boolean }
  | { k: 'c'; c: Vec2; r: number }
export type Loop = Seg[]
export interface Profile {
  /** stable-ish key: centroid + area (see profileKey) */
  key: string
  outer: Loop
  holes: Loop[]
  area: number
  centroid: Vec2
}

/** What a Sketch feature publishes through ctx.dataOf(). */
export interface SketchData {
  plane: PlaneDef
  entities: Entity[]
  constraints: Constraint[]
  profiles: Profile[]
}

export const profileKey = (cx: number, cy: number, area: number) => `${+cx.toFixed(3)},${+cy.toFixed(3)},${+area.toFixed(2)}`
