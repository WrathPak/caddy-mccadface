/** Data model of the Drawing workspace. Everything here is plain JSON: it is saved as drawings.json in the .caddy file. */
import type { EdgeRef, VertexRef } from '@/doc/refs'

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]

/** A body in a view; `occ` is the placed instance of an assembly component it belongs to (absent for a plain body). */
export interface ViewItem { bodyId: string; occ?: string }

export type ProjectionType = 'first' | 'third'
export type ViewKind = 'base' | 'projected' | 'section' | 'detail' | 'iso'

export interface DrawingView {
  id: string
  kind: ViewKind
  /** shown under the view ("FRONT", "SECTION A-A", "DETAIL B") */
  label: string
  /** the things drawn in this view: a body, or a body inside a placed component */
  items: ViewItem[]
  /** unit vector from the model towards the viewer, and the unit vector to the right of the view */
  eye: Vec3
  right: Vec3
  /** orientation name for the UI ('front', 'top', 'iso', 'custom'...) */
  orientation: string
  scale: number
  /** sheet position (mm) where the view point `anchor` sits */
  pos: Vec2
  /** a point in the view's own plane coordinates (model mm) that is pinned to `pos` */
  anchor: Vec2
  parentId?: string
  /** projected / section views slide along one axis of the sheet to stay aligned with their parent: 'h' slides sideways, 'v' up and down */
  align?: 'h' | 'v'
  showHidden: boolean
  showTangent: boolean
  showCenter: boolean
  showLabel: boolean
  /** section view: the cut line in the parent view's plane coordinates; the plane contains the parent's viewing direction */
  cut?: { a: Vec2; b: Vec2; flip: boolean; letter: string }
  /** detail view: a circle in the parent view's plane coordinates */
  detail?: { c: Vec2; r: number; letter: string }
}

/** A point on the model that a dimension is attached to. It follows the model through edits (persistent names). */
export type PointRole = 'vertex' | 'start' | 'end' | 'mid' | 'center' | 'ext+x' | 'ext-x' | 'ext+y' | 'ext-y'
export interface PointRef {
  ref: VertexRef | EdgeRef
  /** the placed instance the point is on (assemblies) */
  occ?: string
  role: PointRole
}

export type DimType = 'linear' | 'aligned' | 'angular' | 'radius' | 'diameter' | 'ordinate' | 'baseline'

export interface Dimension {
  id: string
  viewId: string
  type: DimType
  /** linear, aligned: 2 points. angular: vertex then two points. radius, diameter: the circle's edge (role center). ordinate: origin then point. baseline: base then targets. */
  pts: PointRef[]
  /** which way a linear / ordinate / baseline dimension measures: 'h' along the sheet x, 'v' along the sheet y */
  axis: 'h' | 'v'
  /** sheet mm: how far the dimension line sits from the geometry (radius / diameter: leader length) */
  offset: number
  /** radius / diameter: direction of the leader, degrees */
  angle: number
  /** replaces the measured text; `<>` stands for the value */
  text: string
  /** decimals */
  precision: number
  tolPlus: string
  tolMinus: string
}

export type GdtSymbol =
  | 'straightness' | 'flatness' | 'circularity' | 'cylindricity' | 'lineProfile' | 'surfaceProfile'
  | 'parallelism' | 'perpendicularity' | 'angularity' | 'position' | 'concentricity' | 'symmetry' | 'runout' | 'totalRunout'

export type FinishKind = 'any' | 'removal' | 'prohibited'

interface AnnBase { id: string; sheetId?: string }
export type Annotation =
  | (AnnBase & { kind: 'note'; pos: Vec2; text: string; size: number })
  | (AnnBase & { kind: 'leader'; /** arrow tip first, then the bends; the text sits at the last point */ pts: Vec2[]; text: string; size: number })
  | (AnnBase & { kind: 'gdt'; pos: Vec2; symbol: GdtSymbol; tol: string; /** M, L or empty */ modifier: string; datums: string[]; diameter: boolean; /** arrow tip, optional */ tip?: Vec2 })
  | (AnnBase & { kind: 'datum'; pos: Vec2; letter: string; tip?: Vec2 })
  | (AnnBase & { kind: 'finish'; pos: Vec2; ra: string; method: FinishKind; allowance: string; lay: string })
  | (AnnBase & { kind: 'balloon'; pos: Vec2; /** component key from the parts list */ item: string; /** the point the leader points at */ tip: Vec2 })
  | (AnnBase & { kind: 'partsList'; pos: Vec2 })

export interface TitleCell {
  id: string
  label: string
  /** key into the sheet's title block values, or a built-in: sheet, scale, date, projection */
  key: string
  /** mm from the lower left corner of the block, to the cell lower left corner */
  x: number
  y: number
  w: number
  h: number
  size: number
  /** the text is large (the drawing title) */
  big?: boolean
}
export interface TitleBlockTemplate {
  name: string
  /** overall size, mm */
  w: number
  h: number
  cells: TitleCell[]
  /** the first / third angle symbol in the block */
  showProjection: boolean
}

export interface Sheet {
  id: string
  name: string
  size: string
  portrait: boolean
  projection: ProjectionType
  /** the view scale used when a new view is made */
  scale: number
  margin: number
  titleBlock: Record<string, string>
  views: DrawingView[]
  dims: Dimension[]
  notes: Annotation[]
}

export interface DrawingSettings {
  textHeight: number
  arrowSize: number
  precision: number
  hatchSpacing: number
}

export interface DrawingDoc {
  sheets: Sheet[]
  active: string
  template: TitleBlockTemplate
  settings: DrawingSettings
}

/** Line styles the renderers and exporters know. */
export type LineStyle = 'visible' | 'hidden' | 'tangent' | 'center' | 'thin' | 'cut' | 'dim' | 'border' | 'hatch' | 'phantom' | 'fill'

/** Neutral picture of a sheet: the screen, SVG, DXF and PDF are all drawn from this list. Coordinates are sheet mm, y up. */
export type Prim =
  | { k: 'path'; pts: number[]; style: LineStyle; closed?: boolean; owner?: string; fill?: 'solid' | 'none'; /** not drawn: only there so the thing can be clicked */ pick?: boolean }
  | { k: 'text'; x: number; y: number; text: string; size: number; anchor: 'start' | 'middle' | 'end'; rot?: number; bold?: boolean; owner?: string; style?: LineStyle }
