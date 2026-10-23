/** Sketch data model (plane-local 2D). Shared by the editor, the feature compute and the kernel ops. */

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]

/** Sketch plane in world space. Local y = normal x xDir. */
export interface PlaneDef { origin: Vec3; xDir: Vec3; normal: Vec3 }

/** Id of the implicit, fixed sketch origin point. */
export const ORIGIN = 'O'

/**
 * `ref`: projected reference geometry (see the Project tool). It is fixed in place (the solver treats it as constants),
 * is not draggable and takes part in profile detection like any other curve. Projected geometry is associative: it belongs to a
 * `Projection` (see below) that is re-evaluated on every regeneration; `broken` marks entities whose source no longer resolves.
 */
export interface PointE { id: string; type: 'point'; x: number; y: number; construction?: boolean; ref?: boolean; broken?: boolean }
export interface LineE { id: string; type: 'line'; p1: string; p2: string; construction?: boolean; ref?: boolean; broken?: boolean }
export interface CircleE { id: string; type: 'circle'; c: string; r: number; construction?: boolean; ref?: boolean; broken?: boolean }
/** Counter-clockwise arc from `s` to `e` around `c`. */
export interface ArcE { id: string; type: 'arc'; c: string; s: string; e: string; construction?: boolean; ref?: boolean; broken?: boolean }
export type Entity = PointE | LineE | CircleE | ArcE

export type ConstraintType =
  | 'coincident' | 'pointOnLine' | 'pointOnCurve' | 'onAxis' | 'midpoint'
  | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'tangent' | 'tangentAt' | 'equal' | 'fix'
  | 'distance' | 'hdist' | 'vdist' | 'radius' | 'diameter' | 'angle' | 'offset'

export interface Constraint {
  id: string
  type: ConstraintType
  /**
   * Entity ids. coincident: [pointA, pointB]; pointOnLine/pointOnCurve/midpoint: [point, curve]; onAxis/fix: [point];
   * horizontal/vertical: [line] or [pointA, pointB]; parallel/perpendicular/tangent/equal: [a, b]; tangentAt:
   * [curveA, curveB, point] (tangent at their shared end point; `value` is 0 when both run the same way there, 180
   * when opposite); distance:
   * [pointA, pointB] or [point, line]; hdist/vdist: [pointA, pointB]; radius/diameter: [circle|arc]; angle:
   * [lineA, lineB] (between lines) or [line] / [pointA, pointB] (direction measured from the sketch +X axis);
   * offset: [offsetCurve, sourceCurve] (two lines: point-to-line distance of the offset line's first point; two
   * circles / arcs: radius difference).
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
  /**
   * Dimensions created together share a `group` (editing one edits all). Only the first is drawn; the others are
   * `hidden` and exist to keep the rest of the construction (e.g. the other sides of an offset) consistent.
   */
  group?: string
  hidden?: boolean
}

export const DIM_TYPES: ConstraintType[] = ['distance', 'hdist', 'vdist', 'radius', 'diameter', 'angle', 'offset']
export const isDim = (c: Constraint) => DIM_TYPES.includes(c.type)

/**
 * An associative Project: `ref` is an encoded GeoRef (@/doc/refs: face, edge or body of a B-rep) that is re-resolved and
 * re-projected whenever the sketch regenerates. `ents` lists the curve entities it produced, in the order the kernel
 * returned the curves (null: that curve was already present as ordinary geometry, or its entity was deleted).
 */
export interface Projection { id: string; ref: string; ents: (string | null)[]; broken?: boolean }

export interface SketchModel {
  entities: Entity[]
  constraints: Constraint[]
  next: number
  projections?: Projection[]
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
