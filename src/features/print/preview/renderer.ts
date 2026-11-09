/**
 * Draws a slice's toolpaths: every extrusion segment is one instance of a small bead shape, placed by the vertex shader from
 * its two end points, width and height. The segments are grouped in layer-aligned chunks of about 120 thousand so a layer range
 * hides whole chunks at no cost, and chunks are built one at a time between frames so a big plate never blocks the page.
 */
import {
  BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry,
  InstancedInterleavedBuffer, InterleavedBufferAttribute, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, ShaderMaterial,
  SphereGeometry, SRGBColorSpace, type IUniform,
} from 'three'
import type { ToolpathExtras, Toolpaths } from '@muon3d/slicer-engine-protocol'
import { beadShape, detailFor, type BeadShape, type Detail } from './bead'
import { countVisible, planChunks, RAMP, segmentRange, valueSet, type Chunk, type ColorMode, type ValueSet, type ViewRange } from './data'
import { hexToRgb, roleColor } from './roles'

export const MAX_ROLES = 32
export const MAX_FILAMENTS = 16

const VERT = /* glsl */ `
attribute vec3 aNorm;
attribute float aEnd;
attribute vec3 aP0;
attribute vec3 aP1;
attribute vec4 aMeta;
attribute float aVal;
uniform vec4 uRole[${MAX_ROLES}];
uniform vec4 uFil[${MAX_FILAMENTS}];
uniform vec3 uRamp[${RAMP.length}];
uniform float uMode;
uniform float uLo;
uniform float uHi;
uniform float uLineW;
uniform float uLayerH;
varying vec3 vN;
varying vec3 vC;

float size(float code) { return code <= 200.0 ? code * 0.01 : 2.0 + (code - 200.0) * 0.05; }

vec3 ramp(float t) {
  float x = clamp(t, 0.0, 1.0) * ${(RAMP.length - 1).toFixed(1)};
  int i = int(min(floor(x), ${(RAMP.length - 2).toFixed(1)}));
  return mix(uRamp[i], uRamp[i + 1], x - float(i));
}

void main() {
  float id = float(gl_InstanceID);
  vec4 role = uRole[int(aMeta.x)];
  vec4 fil = uFil[int(aMeta.w)];
  if (id < uLo || id >= uHi || role.a < 0.5 || fil.a < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vN = vec3(0.0, 0.0, 1.0);
    vC = vec3(0.0);
    return;
  }
  float w = aMeta.y > 0.5 ? size(aMeta.y) : uLineW;
  float h = aMeta.z > 0.5 ? size(aMeta.z) : uLayerH;
  vec3 d = aP1 - aP0;
  float len = length(d);
  vec3 t = len > 1e-6 ? d / len : vec3(1.0, 0.0, 0.0);
  vec3 right = cross(t, vec3(0.0, 0.0, 1.0));
  float rl = length(right);
  right = rl > 1e-4 ? right / rl : vec3(1.0, 0.0, 0.0);
  vec3 up = cross(right, t);
  vec3 outward = aEnd < 0.5 ? -t : t;
  vec3 base = (aEnd < 0.5 ? aP0 : aP1) - up * (h * 0.5);
  vec3 p = base + right * (position.x * w * 0.5) + up * (position.y * h * 0.5) + outward * (position.z * w * 0.5);
  // normal of the stretched shape: the cross-section stretches by w and h, so its normal scales the other way
  vec3 nl = vec3(aNorm.x * h, aNorm.y * w, aNorm.z * min(w, h));
  vec3 n = normalize(right * nl.x + up * nl.y + outward * nl.z);
  vN = normalize(mat3(viewMatrix) * n);
  vec3 c;
  if (uMode < 0.5) c = role.rgb;
  else if (uMode < 1.5) c = fil.rgb;
  else c = ramp(aVal);
  vC = c;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(p, 1.0);
}
`

const FRAG = /* glsl */ `
varying vec3 vN;
varying vec3 vC;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 key = normalize(vec3(0.62, 0.38, 0.70));
  float diff = max(dot(n, key), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.7, -0.2, 0.4))), 0.0);
  float spec = pow(max(dot(n, normalize(key + vec3(0.0, 0.0, 1.0))), 0.0), 28.0);
  vec3 col = vC * (0.30 + 0.66 * diff + 0.14 * fill) + vec3(0.10) * spec;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export interface RendererInput {
  toolpaths: Toolpaths
  extras: ToolpathExtras | null
  /** filament index per segment, null for a single filament */
  filament: Uint8Array | null
  filamentColors: string[]
  /** bed (0,0,0) in the world */
  origin: [number, number, number]
  /** bed size, for the nozzle marker scale only */
  layerHeight: number
}

export interface RendererState {
  range: ViewRange
  mode: ColorMode
  /** by role index */
  roleOn: boolean[]
  filOn: boolean[]
  travel: boolean
}

interface ChunkMesh {
  chunk: Chunk
  mesh: Mesh
  material: ShaderMaterial
  geoms: Partial<Record<Detail, InstancedBufferGeometry>>
  aP0: InterleavedBufferAttribute
  aP1: InterleavedBufferAttribute
  aMeta: InstancedBufferAttribute
  aVal: InstancedBufferAttribute | null
  buffer: InstancedInterleavedBuffer
  detail: Detail | null
  valueMode?: ColorMode
}

const linear = (rgb: [number, number, number], srgb: boolean): [number, number, number] => {
  const c = new Color()
  if (srgb) c.setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace)
  else c.setRGB(rgb[0], rgb[1], rgb[2])
  return [c.r, c.g, c.b]
}
const toLinear = (hex: string) => linear(hexToRgb(hex), true)

/** Wait for the next frame (or a short timeout when the tab is hidden). */
const nextFrame = () => new Promise<void>((resolve) => {
  let done = false
  const fin = () => { if (!done) { done = true; resolve() } }
  requestAnimationFrame(fin)
  setTimeout(fin, 50)
})

export class ToolpathRenderer {
  readonly group = new Group()
  readonly chunks: ChunkMesh[] = []
  readonly roleNames: string[]
  private readonly shared: Record<string, IUniform>
  private readonly marker: Mesh
  private readonly travel: LineSegments | null
  private values = new Map<ColorMode, ValueSet | null>()
  private disposed = false
  private filament: Uint8Array | null
  private baseGeoms = new Map<Detail, { pos: BufferAttribute; norm: BufferAttribute; end: BufferAttribute; index: BufferAttribute }>()
  private state: RendererState | null = null
  /** timings for the e2e and the performance notes */
  readonly timings = { buildMs: 0, firstChunkMs: 0, chunkCount: 0, ready: false }
  lastDetail: Detail = 'high'
  lastVisible = 0
  onChange: (() => void) | null = null

  constructor(private readonly input: RendererInput) {
    const tp = input.toolpaths
    this.roleNames = tp.roles.map((r) => r.name)
    this.filament = input.filament
    this.group.name = 'slice-preview'
    this.group.position.set(...input.origin)
    const roleTable = new Float32Array(MAX_ROLES * 4)
    tp.roles.forEach((r, i) => { if (i < MAX_ROLES) roleTable.set([...toLinear(roleColor(r.name)), 1], i * 4) })
    const filTable = new Float32Array(MAX_FILAMENTS * 4)
    for (let i = 0; i < MAX_FILAMENTS; i++) filTable.set([...toLinear(input.filamentColors[i] ?? '#cccccc'), 1], i * 4)
    const rampTable = new Float32Array(RAMP.length * 3)
    RAMP.forEach((c, i) => rampTable.set(linear(c, true), i * 3))
    this.shared = {
      uRole: { value: roleTable },
      uFil: { value: filTable },
      uRamp: { value: rampTable },
      uMode: { value: 0 },
      uLineW: { value: tp.lineWidth ?? 0.42 },
      uLayerH: { value: input.layerHeight },
    }
    // the marker for the nozzle position while scrubbing
    this.marker = new Mesh(new SphereGeometry(1, 20, 14), new MeshBasicMaterial({ color: new Color('#ffffff'), toneMapped: false, depthTest: false, transparent: true, opacity: 0.95 }))
    this.marker.renderOrder = 5
    this.marker.visible = false
    this.marker.raycast = () => null
    this.marker.userData.noAo = true
    this.group.add(this.marker)
    if (tp.travels.count > 0) {
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(tp.travels.positions, 3))
      this.travel = new LineSegments(g, new LineBasicMaterial({ color: new Color('#7f9bff'), transparent: true, opacity: 0.55, depthWrite: false }))
      this.travel.frustumCulled = false
      this.travel.visible = false
      this.travel.raycast = () => null
      this.travel.userData.noAo = true
      this.group.add(this.travel)
    } else this.travel = null
  }

  /** Build the chunks one at a time between frames. Resolves when every chunk is on the GPU path. */
  async build(): Promise<void> {
    const t0 = performance.now()
    const tp = this.input.toolpaths
    const plan = planChunks(tp.extrusions.layerStart)
    let budgetStart = performance.now()
    for (const c of plan) {
      if (this.disposed) return
      this.addChunk(c)
      if (this.chunks.length === 1) this.timings.firstChunkMs = performance.now() - t0
      this.apply()
      this.onChange?.()
      if (performance.now() - budgetStart > 5) {
        await nextFrame()
        budgetStart = performance.now()
      }
    }
    this.timings.buildMs = performance.now() - t0
    this.timings.chunkCount = this.chunks.length
    this.timings.ready = true
    this.onChange?.()
  }

  private addChunk(c: Chunk) {
    const tp = this.input.toolpaths
    const ex = tp.extrusions
    const n = c.end - c.start
    const meta = new Uint8Array(n * 4)
    const fil = this.filament
    for (let i = 0; i < n; i++) {
      const s = c.start + i
      meta[i * 4] = Math.min(MAX_ROLES - 1, ex.roleIndex[s])
      meta[i * 4 + 1] = ex.width[s]
      meta[i * 4 + 2] = ex.height[s]
      meta[i * 4 + 3] = fil ? Math.min(MAX_FILAMENTS - 1, fil[s]) : 0
    }
    const buffer = new InstancedInterleavedBuffer(ex.positions.subarray(c.start * 6, c.end * 6), 6, 1)
    const material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...this.shared, uLo: { value: 0 }, uHi: { value: n } },
    })
    const cm: ChunkMesh = {
      chunk: c, material, geoms: {}, buffer, detail: null,
      aP0: new InterleavedBufferAttribute(buffer, 3, 0),
      aP1: new InterleavedBufferAttribute(buffer, 3, 3),
      aMeta: new InstancedBufferAttribute(meta, 4, false),
      aVal: null,
      mesh: new Mesh(),
    }
    cm.mesh.material = material
    cm.mesh.frustumCulled = false
    cm.mesh.raycast = () => null
    cm.mesh.userData.noAo = true
    cm.mesh.visible = false
    this.chunks.push(cm)
    this.group.add(cm.mesh)
  }

  private base(d: Detail) {
    let b = this.baseGeoms.get(d)
    if (!b) {
      const s: BeadShape = beadShape(d)
      b = { pos: new BufferAttribute(s.pos, 3), norm: new BufferAttribute(s.norm, 3), end: new BufferAttribute(s.end, 1), index: new BufferAttribute(s.index, 1) }
      this.baseGeoms.set(d, b)
    }
    return b
  }

  private geometryFor(cm: ChunkMesh, d: Detail): InstancedBufferGeometry {
    let g = cm.geoms[d]
    if (!g) {
      const b = this.base(d)
      g = new InstancedBufferGeometry()
      g.setIndex(b.index)
      g.setAttribute('position', b.pos)
      g.setAttribute('aNorm', b.norm)
      g.setAttribute('aEnd', b.end)
      g.setAttribute('aP0', cm.aP0)
      g.setAttribute('aP1', cm.aP1)
      g.setAttribute('aMeta', cm.aMeta)
      if (cm.aVal) g.setAttribute('aVal', cm.aVal)
      g.instanceCount = cm.chunk.end - cm.chunk.start
      cm.geoms[d] = g
    }
    return g
  }

  /** The filament per segment arrives after the chunks are drawn (the G-code scan runs in a worker): patch the ones built so far. */
  setFilament(fil: Uint8Array) {
    this.filament = fil
    for (const cm of this.chunks) {
      const meta = cm.aMeta.array as Uint8Array
      const n = cm.chunk.end - cm.chunk.start
      for (let i = 0; i < n; i++) meta[i * 4 + 3] = Math.min(MAX_FILAMENTS - 1, fil[cm.chunk.start + i])
      cm.aMeta.needsUpdate = true
    }
    this.onChange?.()
  }

  /** Set the view: layer range, scrub, color mode, feature and filament switches, travel lines. */
  setState(s: RendererState) {
    this.state = s
    this.apply()
  }

  /** Segment value bytes for a continuous color mode (cached). Null when the data is not there. */
  valuesFor(mode: ColorMode): ValueSet | null {
    if (!this.values.has(mode)) this.values.set(mode, valueSet(mode, this.input.toolpaths, this.input.extras))
    return this.values.get(mode) ?? null
  }

  private ensureValues(mode: ColorMode): boolean {
    const vs = this.valuesFor(mode)
    if (!vs) return false
    for (const cm of this.chunks) {
      const sub = vs.bytes.subarray(cm.chunk.start, cm.chunk.end)
      if (!cm.aVal) {
        cm.aVal = new InstancedBufferAttribute(new Uint8Array(sub), 1, true)
        cm.aVal.setUsage(DynamicDrawUsage)
        for (const g of Object.values(cm.geoms)) g?.setAttribute('aVal', cm.aVal)
      } else if (cm.valueMode !== mode) {
        ;(cm.aVal.array as Uint8Array).set(sub)
        cm.aVal.needsUpdate = true
      }
      cm.valueMode = mode
    }
    return true
  }

  private apply() {
    const s = this.state
    if (!s || this.disposed) return
    const tp = this.input.toolpaths
    const mode: ColorMode = s.mode
    const valueMode = mode !== 'feature' && mode !== 'filament'
    const ok = valueMode ? this.ensureValues(mode) : true
    this.shared.uMode.value = !valueMode ? (mode === 'filament' ? 1 : 0) : ok ? 2 : 0
    const roleTable = this.shared.uRole.value as Float32Array
    for (let i = 0; i < MAX_ROLES; i++) roleTable[i * 4 + 3] = s.roleOn[i] === false ? 0 : 1
    const filTable = this.shared.uFil.value as Float32Array
    for (let i = 0; i < MAX_FILAMENTS; i++) filTable[i * 4 + 3] = s.filOn[i] === false ? 0 : 1
    const [a, b] = segmentRange(tp.extrusions.layerStart, s.range)
    let visible = 0
    for (const cm of this.chunks) visible += Math.max(0, Math.min(b, cm.chunk.end) - Math.max(a, cm.chunk.start))
    const detail = detailFor(visible)
    this.lastDetail = detail
    this.lastVisible = visible
    for (const cm of this.chunks) {
      const lo = Math.max(a, cm.chunk.start) - cm.chunk.start
      const hi = Math.min(b, cm.chunk.end) - cm.chunk.start
      const show = hi > lo
      cm.mesh.visible = show
      if (!show) continue
      cm.material.uniforms.uLo.value = lo
      cm.material.uniforms.uHi.value = hi
      if (cm.detail !== detail) {
        cm.mesh.geometry = this.geometryFor(cm, detail)
        cm.detail = detail
      } else if (valueMode && cm.aVal && !cm.mesh.geometry.getAttribute('aVal')) {
        cm.mesh.geometry = this.geometryFor(cm, detail)
      }
    }
    // the nozzle: at the end of the last drawn segment while the top layer is partly drawn
    const ex = tp.extrusions
    if (s.range.scrub < 1 && b > a) {
      const o = (b - 1) * 6
      this.marker.position.set(ex.positions[o + 3], ex.positions[o + 4], ex.positions[o + 5] - this.input.layerHeight / 2)
      const r = Math.max(0.5, (tp.lineWidth ?? 0.42) * 1.4)
      this.marker.scale.setScalar(r)
      this.marker.visible = true
    } else this.marker.visible = false
    if (this.travel) {
      const ls = tp.travels.layerStart
      const layers = ls.length - 1
      const lo = Math.max(0, Math.min(layers - 1, s.range.lo)), hi = Math.max(lo, Math.min(layers - 1, s.range.hi))
      this.travel.visible = s.travel
      this.travel.geometry.setDrawRange(ls[lo] * 2, (ls[hi + 1] - ls[lo]) * 2)
    }
  }

  /** What is drawn right now: for the e2e hook and the performance notes. */
  stats() {
    const s = this.state
    const vis = this.chunks.filter((c) => c.mesh.visible)
    return {
      ready: this.timings.ready,
      chunks: this.chunks.length,
      visibleChunks: vis.length,
      /** segments in the layer range (what the chunks instance) */
      instances: this.lastVisible,
      /** segments that pass the range and the feature / filament switches (counted here, on demand) */
      drawn: s ? countVisible(this.input.toolpaths, s.range, s.roleOn, this.filament, s.filOn).segments : 0,
      detail: this.lastDetail,
      range: s ? { lo: s.range.lo, hi: s.range.hi, scrub: s.range.scrub } : null,
      mode: s?.mode ?? null,
      markerVisible: this.marker.visible,
      travelVisible: this.travel?.visible ?? false,
      timings: { ...this.timings },
    }
  }

  dispose() {
    this.disposed = true
    for (const cm of this.chunks) {
      for (const g of Object.values(cm.geoms)) g?.dispose()
      cm.material.dispose()
    }
    this.marker.geometry.dispose()
    ;(this.marker.material as MeshBasicMaterial).dispose()
    if (this.travel) { this.travel.geometry.dispose(); (this.travel.material as LineBasicMaterial).dispose() }
    this.group.clear()
    this.chunks.length = 0
    this.values.clear()
  }
}

