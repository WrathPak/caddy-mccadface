/**
 * CADdy McCADFace plugin API.
 *
 * A plugin is a plain ES module that runs in a sandbox (a Web Worker with no DOM and no network). The app hands it one object,
 * `caddy`, and everything a plugin can do goes through it:
 *
 *   export function activate(caddy) { ... }
 *
 * To get completion and checking in your editor, put this file next to the plugin and start the plugin with
 *
 *   // @ts-check
 *   /// <reference path="caddy-api.d.ts" />
 *
 * The app serves this same file at /caddy-api.d.ts, and the Plugins panel has a button to download it.
 * docs/plugins.md walks through all of it.
 */

/** Version of this API. It changes when something plugins rely on changes. */
declare const CADDY_API_VERSION: '1'

/** The `caddy` object: handed to `activate(caddy)`, and also a global in the Script panel. */
declare const caddy: CaddyApi

type CaddyVec3 = [number, number, number]
type CaddyVec2 = [number, number]
type CaddyParamValue = number | string | boolean | CaddyVec3 | string[]
type CaddyParams = Record<string, CaddyParamValue>

/** Things a plugin must ask for in its manifest (`permissions`) and the user must allow. Everything else is always available. */
type CaddyPermission = 'document:write' | 'commands:run' | 'download'

/** The icons a plugin can pick for its commands and features. */
type CaddyIconName = 'puzzle' | 'gear' | 'cube' | 'cylinder' | 'sphere' | 'download' | 'upload' | 'wrench' | 'ruler' | 'pencil' | 'star' | 'bolt' | 'package' | 'shapes' | 'text'

interface CaddyDisposable {
  /** Stop listening. */
  dispose(): void
}

// ---------------------------------------------------------------- parameters (what a feature's dialog shows)

interface CaddyParamBase {
  /** key in the `params` object passed to compute */
  key: string
  label: string
  /** plain-language explanation shown as a tooltip and while the field is focused */
  help?: string
  /** show the field only while another field has a given value */
  visibleWhen?: { key: string; equals?: CaddyParamValue; in?: CaddyParamValue[] }
}
interface CaddyNumberParam extends CaddyParamBase { type: 'number'; unit?: 'mm' | 'deg' | '%' | ''; min?: number; max?: number; step?: number; default: number }
interface CaddyEnumParam extends CaddyParamBase {
  type: 'enum'
  options: { value: string; label: string; desc?: string }[]
  /** 'segmented' for a few short options, 'list' for options with a description, otherwise a dropdown */
  display?: 'segmented' | 'select' | 'list'
  default: string
}
interface CaddyBoolParam extends CaddyParamBase { type: 'bool'; default: boolean }
interface CaddyVectorParam extends CaddyParamBase { type: 'vector3'; unit?: 'mm' | 'deg' | ''; step?: number; default: CaddyVec3 }
interface CaddyTextParam extends CaddyParamBase { type: 'text'; multiline?: boolean; placeholder?: string; default: string }
interface CaddySelectionParam extends CaddyParamBase {
  type: 'selection-ref'
  accepts: ('body' | 'face' | 'edge' | 'sketch' | 'plane' | 'axis' | 'point' | 'vertex')[]
  multiple?: boolean
  /** the dialog cannot be confirmed until something is picked */
  required?: boolean
  /** compute() gets the picked body ids when `accepts` is just ['body'], otherwise opaque reference strings */
  default?: string[]
}
interface CaddyGroupParam { type: 'group'; label: string; help?: string; collapsed?: boolean; children: CaddyParamDef[] }
type CaddyParamDef = CaddyNumberParam | CaddyEnumParam | CaddyBoolParam | CaddyVectorParam | CaddyTextParam | CaddySelectionParam | CaddyGroupParam

// ---------------------------------------------------------------- bodies and the kernel

interface CaddyBounds { min: CaddyVec3; max: CaddyVec3 }

/** A solid or mesh. `handle` is how you refer to it in kernel calls. */
interface CaddyBody {
  handle: string
  kind: 'brep' | 'mesh'
  /** triangles of the display mesh */
  triangles: number
  bounds: CaddyBounds
}

/** A body in the document: a CaddyBody plus its id and name. */
interface CaddyBodyInfo extends CaddyBody {
  id: string
  name: string
}

/** A body as an argument: the object a kernel call returned, or just its handle. */
type CaddyBodyRef = CaddyBody | { handle: string } | string

interface CaddyMeshData {
  /** x, y, z per vertex */
  positions: Float32Array
  /** three vertex indices per triangle */
  indices: Uint32Array
}

interface CaddyBooleanJob {
  op: 'union' | 'subtract' | 'intersect'
  base: CaddyBodyRef
  tools: CaddyBodyRef[]
}

/**
 * Geometry. Solids (`box`, `cylinder`, `sphere`, `extrude`) are exact B-reps from OpenCascade; meshes are triangle soups handled by
 * manifold. Every call returns a new body and never changes its inputs. Dimensions are millimetres, angles degrees.
 */
interface CaddyKernel {
  /** `position` is the middle of the bottom face (like the Box feature), default [0, 0, 0]. */
  box(o: { size: CaddyVec3; position?: CaddyVec3 }): Promise<CaddyBody>
  /** Axis along +Z, `position` is the centre of the bottom face. */
  cylinder(o: { radius: number; height: number; position?: CaddyVec3 }): Promise<CaddyBody>
  sphere(o: { radius: number; center?: CaddyVec3 }): Promise<CaddyBody>
  /**
   * Extrude a polygon (with optional holes) along the plane's normal. `outline` and each hole are lists of [x, y] points in the
   * plane's own coordinates; the plane is XY (normal +Z), XZ (normal -Y) or YZ (normal +X), moved to `origin`.
   */
  extrude(o: { outline: CaddyVec2[]; holes?: CaddyVec2[][]; height: number; plane?: 'XY' | 'XZ' | 'YZ'; origin?: CaddyVec3 }): Promise<CaddyBody>
  /** Union, difference or intersection. Solids stay exact when every input is a solid; otherwise the result is a mesh. */
  boolean(o: CaddyBooleanJob): Promise<CaddyBody>
  /** Move, rotate (degrees, about X then Y then Z through `pivot`) and scale (uniformly). */
  transform(o: { body: CaddyBodyRef; translate?: CaddyVec3; rotate?: CaddyVec3; scale?: number; pivot?: CaddyVec3 }): Promise<CaddyBody>
  /** Turn a solid into a triangle mesh body. */
  toMesh(body: CaddyBodyRef): Promise<CaddyBody>
  /** The welded triangles of any body (a solid is tessellated first). */
  triangles(body: CaddyBodyRef): Promise<CaddyMeshData>
  mesh: {
    /** Make a mesh body from triangles (3 numbers per vertex; `indices` are optional, without them every 3 vertices are a triangle). */
    fromTriangles(o: { positions: ArrayLike<number>; indices?: ArrayLike<number> }): Promise<CaddyBody>
    /** A mesh boolean through manifold (solids are converted to meshes first). */
    boolean(o: CaddyBooleanJob): Promise<CaddyBody>
    /** Independent mesh booleans, run side by side on the worker pool. Results come back in the order of `jobs`. */
    booleanMany(jobs: CaddyBooleanJob[]): Promise<CaddyBody[]>
  }
}

// ---------------------------------------------------------------- features, commands, ribbon

interface CaddyComputeContext {
  /** the feature being built */
  feature: { id: string; name: string }
  /** the bodies that exist before this feature */
  bodies: CaddyBodyInfo[]
  /** same as `caddy.kernel` */
  kernel: CaddyKernel
}

interface CaddyComputeResult {
  /** bodies to add (a body with an existing id replaces it); the first one gets the feature's own id */
  bodies?: CaddyBodyRef[]
  /** ids of existing bodies to remove */
  remove?: string[]
  /** a problem worth showing on the feature that did not stop it from building */
  warning?: string
}

interface CaddyRibbonPlacement {
  /** which ribbon tab (default 'solid') */
  tab?: 'solid' | 'mesh' | 'hair' | 'sketch'
  /** the group on that tab; a group with that name is created when it does not exist (default: the plugin's name) */
  group?: string
}

interface CaddyFeatureDefinition {
  /** unique within the plugin, e.g. 'gear' (the app stores it as '<plugin id>.gear') */
  type: string
  label: string
  icon?: CaddyIconName
  /** the fields of the dialog */
  params: CaddyParamDef[]
  /** Build the geometry. Runs in the sandbox every time the timeline regenerates, so keep it a pure function of `params` and `ctx`. */
  compute(ctx: CaddyComputeContext, params: CaddyParams): CaddyComputeResult | Promise<CaddyComputeResult>
  /** Put a button for creating this feature on the ribbon (and a command with the same label in the palette). */
  ribbon?: CaddyRibbonPlacement
}

interface CaddyCommandDefinition {
  /** unique within the plugin */
  id: string
  label: string
  /** longer text for the tooltip */
  tip?: string
  icon?: CaddyIconName
  /** e.g. 'Ctrl+Shift+E' */
  shortcut?: string
  run(): void | Promise<void>
  /** Put a button for this command on the ribbon. */
  ribbon?: CaddyRibbonPlacement
}

// ---------------------------------------------------------------- document and selection

interface CaddyFeatureInfo {
  id: string
  type: string
  name: string
  state: 'ok' | 'warning' | 'error' | 'suppressed'
  suppressed: boolean
  params: CaddyParams
}

interface CaddyDocument {
  info(): Promise<{ name: string; featureCount: number; /** how many features are switched on (the rollback marker) */ rollback: number; dirty: boolean }>
  features(): Promise<CaddyFeatureInfo[]>
  bodies(): Promise<CaddyBodyInfo[]>
  userParams(): Promise<{ name: string; expr: string }[]>
  /** Append a feature at the rollback marker and return its id. Needs the 'document:write' permission. */
  addFeature(type: string, params: CaddyParams, name?: string): Promise<string>
  /** Needs 'document:write'. */
  updateFeature(id: string, params: CaddyParams): Promise<void>
  /** Needs 'document:write'. */
  removeFeature(id: string): Promise<void>
  /** Called after the document (features or bodies) changed. */
  onChange(callback: () => void): CaddyDisposable
}

interface CaddySelectionRef {
  kind: 'body' | 'face' | 'edge' | 'sketch' | 'mesh' | 'plane' | 'axis' | 'feature' | 'point' | 'vertex'
  /** body / sketch / feature id */
  id: string
  /** face or edge index within the body */
  index?: number
}

interface CaddySelection {
  get(): Promise<CaddySelectionRef[]>
  set(refs: CaddySelectionRef[]): Promise<void>
  onChange(callback: (refs: CaddySelectionRef[]) => void): CaddyDisposable
}

// ---------------------------------------------------------------- the object itself

interface CaddyApi {
  version: '1'
  /** Messages show up in the Plugins panel (and in the Script panel's output). */
  log: { log(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  features: {
    /** Add a feature type: a dialog made from `params`, and `compute` to build it. */
    register(def: CaddyFeatureDefinition): void
  }
  commands: {
    register(def: CaddyCommandDefinition): void
    /** Run any command of the app by id, for example 'view.frame'. Needs the 'commands:run' permission. */
    run(id: string): Promise<void>
  }
  ribbon: {
    /** Show a command (yours or one of the app's) on the ribbon. */
    add(entry: { command: string } & CaddyRibbonPlacement): void
  }
  document: CaddyDocument
  selection: CaddySelection
  kernel: CaddyKernel
  io: {
    /** Offer a file for download. Needs the 'download' permission. */
    download(name: string, data: Uint8Array | ArrayBuffer | string, mime?: string): Promise<void>
  }
  ui: {
    toast(message: string, kind?: 'info' | 'error'): void
  }
}

/** What a plugin module exports. */
interface CaddyPluginModule {
  manifest?: { id?: string; name?: string; version?: string; description?: string; permissions?: CaddyPermission[] }
  activate?(caddy: CaddyApi): void | Promise<void>
  deactivate?(): void | Promise<void>
  default?(caddy: CaddyApi): void | Promise<void>
}
