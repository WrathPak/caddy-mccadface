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
/**
 * Spline through (`fit`) or controlled by (`ctrl`: clamped cubic B-spline) the points `pts`; `bez` holds Bezier pieces
 * (3 n + 1 points: end, two controls, end, ...). A fit spline may carry end tangent handles `t0` / `t1`: points that are
 * the first / last inner control point of the curve, so dragging one turns and stretches the tangent there.
 */
export interface SplineE { id: string; type: 'spline'; mode: 'fit' | 'ctrl' | 'bez'; pts: string[]; closed?: boolean; t0?: string; t1?: string; construction?: boolean; ref?: boolean; broken?: boolean }
/** Ellipse: centre `c`, the end of the major semi-axis `m` (a point, so the axis direction and length are driven by it) and the minor semi-axis `r`. */
export interface EllipseE { id: string; type: 'ellipse'; c: string; m: string; r: number; construction?: boolean; ref?: boolean; broken?: boolean }
/** Text laid out at the anchor point `p`: `h` is the cap height in mm, `a` the angle of the baseline in degrees. Its outlines are profiles. */
export interface TextE { id: string; type: 'text'; p: string; text: string; h: number; a: number; font?: string; construction?: boolean; ref?: boolean; broken?: boolean }
export type Entity = PointE | LineE | CircleE | ArcE | SplineE | EllipseE | TextE

export type ConstraintType =
  | 'coincident' | 'pointOnLine' | 'pointOnCurve' | 'onAxis' | 'midpoint'
  | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'tangent' | 'tangentAt' | 'equal' | 'fix'
  | 'distance' | 'hdist' | 'vdist' | 'radius' | 'diameter' | 'angle' | 'offset'
  | 'splineTangent' | 'majorRadius' | 'mirror' | 'rotated'

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
   *
   * splineTangent: [spline, curve, point] the spline's end handle at `point` (an end of the spline that meets the curve) lies
   * along the curve's tangent there (`value` 0: the spline leaves in the curve's direction, 180: against it).
   * majorRadius: [ellipse] the major semi-axis length. mirror: [point, mirrored point, line] the second is the first
   * reflected across the line. rotated: [centre, point, rotated point] the third is the second turned about the centre by `value` degrees.
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

export const DIM_TYPES: ConstraintType[] = ['distance', 'hdist', 'vdist', 'radius', 'diameter', 'angle', 'offset', 'majorRadius']
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

/** `id`: the sketch entity the segment came from (the root of persistent face names; absent for hand-built loops). */
export type Seg =
  | { k: 'l'; a: Vec2; b: Vec2; id?: string }
  /** arc from a to b through m (centre c, radius r; ccw when traversed a -> b counter-clockwise) */
  | { k: 'a'; a: Vec2; m: Vec2; b: Vec2; c: Vec2; r: number; ccw: boolean; id?: string }
  | { k: 'c'; c: Vec2; r: number; id?: string }
  /** cubic Bezier from a to b with controls c1, c2 (spline, ellipse and text pieces) */
  | { k: 'b'; a: Vec2; c1: Vec2; c2: Vec2; b: Vec2; id?: string }
export type Loop = Seg[]
export interface Profile {
  /** stable-ish key: centroid + area (see profileKey) */
  key: string
  /** persistent id: the entity ids of the outer loop (root of the names of the caps built from it) */
  id?: string
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

/** Persistent id of a profile: the sorted, de-duplicated entity ids of its outer loop (empty when the loop carries none). */
export const profileIdOf = (loop: Loop) => [...new Set(loop.map((s) => s.id).filter((x): x is string => !!x))].sort().join('+')

export const profileKey = (cx: number, cy: number, area: number) => `${+cx.toFixed(3)},${+cy.toFixed(3)},${+area.toFixed(2)}`
