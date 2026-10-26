/** Builds three.js objects from the document for the viewport overlay and the offscreen renderers (no React, no GL context needed). */
import {
  BufferAttribute, BufferGeometry, Color, DataTexture, DataUtils, DoubleSide, EquirectangularReflectionMapping, Euler, Group, HalfFloatType,
  LinearFilter, LinearMipmapLinearFilter, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PlaneGeometry, RGBAFormat, RepeatWrapping, ShadowMaterial,
  SRGBColorSpace, UnsignedByteType, Vector2, Box3, Vector3, DirectionalLight,
} from 'three'
import type { Body } from '@/kernel/types'
import type { AppearanceMap, BodyAppearance } from './appearanceMap'
import { envById, envPixels } from './envmap'
import { effectivePreset, specKey, type AppearanceSpec } from './presets'
import type { RenderSettings } from './settingsCore'
import { carbonTexture, woodTexture, type PixelMap } from './textures'

// ---------------------------------------------------------------- textures and materials

const texCache = new Map<string, DataTexture>()
function pixelTexture(key: string, make: () => PixelMap, srgb: boolean): DataTexture {
  let t = texCache.get(key)
  if (!t) {
    const px = make()
    t = new DataTexture(px.data, px.size, px.size, RGBAFormat, UnsignedByteType)
    t.wrapS = t.wrapT = RepeatWrapping
    t.magFilter = LinearFilter
    t.minFilter = LinearMipmapLinearFilter
    t.generateMipmaps = true
    t.anisotropy = 4
    if (srgb) t.colorSpace = SRGBColorSpace
    t.needsUpdate = true
    texCache.set(key, t)
  }
  return t
}
let carbonCache: ReturnType<typeof carbonTexture> | null = null
const carbon = () => (carbonCache ??= carbonTexture(256))

/** The MeshPhysicalMaterial for a look. `live` is the viewport version: glass is drawn see-through instead of refracting. */
export function makeMaterial(spec: AppearanceSpec, live = false): MeshPhysicalMaterial {
  const p = effectivePreset(spec)
  const glass = p.transmission > 0
  const m = new MeshPhysicalMaterial({
    color: new Color(p.color), roughness: p.roughness, metalness: p.metalness, ior: p.ior,
    clearcoat: p.clearcoat, clearcoatRoughness: p.clearcoatRoughness,
    sheen: p.sheen, sheenRoughness: p.sheenRoughness, sheenColor: new Color(p.sheenColor),
    iridescence: p.iridescence, iridescenceIOR: 1.6, side: DoubleSide,
  })
  if (glass) {
    if (live) { m.transparent = true; m.opacity = 0.32; m.depthWrite = false } else { m.transmission = p.transmission; m.thickness = p.thickness }
  }
  if (p.texture === 'wood') m.map = pixelTexture('wood', () => woodTexture(256), true)
  if (p.texture === 'carbon') {
    m.map = pixelTexture('carbon-c', () => carbon().color, true)
    m.normalMap = pixelTexture('carbon-n', () => carbon().normal, false)
    m.normalScale = new Vector2(0.8, 0.8)
  }
  m.userData.specKey = specKey(spec)
  return m
}

// ---------------------------------------------------------------- geometry

/** Box-projected UVs for a triangle soup: each triangle is flattened along its dominant axis, `tile` mm per repeat. */
export function boxUvs(positions: Float32Array, tile: number): Float32Array {
  const uv = new Float32Array((positions.length / 3) * 2)
  for (let t = 0; t < positions.length; t += 9) {
    const ax = positions[t + 3] - positions[t], ay = positions[t + 4] - positions[t + 1], az = positions[t + 5] - positions[t + 2]
    const bx = positions[t + 6] - positions[t], by = positions[t + 7] - positions[t + 1], bz = positions[t + 8] - positions[t + 2]
    const nx = Math.abs(ay * bz - az * by), ny = Math.abs(az * bx - ax * bz), nz = Math.abs(ax * by - ay * bx)
    const axis = nz >= nx && nz >= ny ? 2 : ny >= nx ? 1 : 0
    for (let k = 0; k < 3; k++) {
      const o = t + k * 3
      const u = axis === 0 ? positions[o + 1] : positions[o]
      const v = axis === 2 ? positions[o + 1] : positions[o + 2]
      uv[((t / 3) + k) * 2] = u / tile
      uv[((t / 3) + k) * 2 + 1] = v / tile
    }
  }
  return uv
}

/** A non-indexed geometry (own vertices, with UVs) of the triangles whose face index passes `pick`. */
export function faceGeometry(body: Body, pick: (face: number) => boolean, tile = 30): BufferGeometry | null {
  const m = body.mesh
  const tris: number[] = []
  for (let t = 0; t < m.faceIds.length; t++) if (pick(m.faceIds[t])) tris.push(t)
  if (!tris.length) return null
  const pos = new Float32Array(tris.length * 9), nor = new Float32Array(tris.length * 9)
  tris.forEach((t, n) => {
    for (let k = 0; k < 3; k++) {
      const i = m.indices[t * 3 + k] * 3
      for (let c = 0; c < 3; c++) { pos[n * 9 + k * 3 + c] = m.positions[i + c]; nor[n * 9 + k * 3 + c] = m.normals[i + c] }
    }
  })
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('normal', new BufferAttribute(nor, 3))
  g.setAttribute('uv', new BufferAttribute(boxUvs(pos, tile), 2))
  return g
}

export interface LookGroup { spec: AppearanceSpec | null; faces: Set<number> | 'rest' }

/** The distinct looks on a body and which faces each covers. `rest` is the faces nothing was assigned to. */
export function lookGroups(body: Body, e: BodyAppearance | undefined): LookGroup[] {
  if (!e || (!e.body && !e.faces.size)) return [{ spec: null, faces: 'rest' }]
  const byKey = new Map<string, LookGroup & { faces: Set<number> }>()
  const total = body.mesh.faceCount ?? Math.max(-1, ...body.mesh.faceIds) + 1
  for (let f = 0; f < total; f++) {
    const spec = e.faces.get(f) ?? e.body
    if (!spec) continue
    const k = specKey(spec)
    let g = byKey.get(k)
    if (!g) byKey.set(k, (g = { spec, faces: new Set() }))
    g.faces.add(f)
  }
  const out: LookGroup[] = [...byKey.values()]
  if (!e.body) out.push({ spec: null, faces: 'rest' })
  return out
}

export interface BuildOptions {
  appearance: AppearanceMap
  hidden: Record<string, true>
  /** viewport version of the materials (see makeMaterial) */
  live?: boolean
  /** the viewport overlay only needs the faces that have a material */
  onlyAssigned?: boolean
  /** the look for faces nothing was assigned to */
  fallback: AppearanceSpec
}

/** All visible bodies as meshes with their materials. Unassigned faces use `fallback`. */
export function buildModel(bodies: Body[], o: BuildOptions): Group {
  const root = new Group()
  root.name = 'render-model'
  const mats = new Map<string, MeshPhysicalMaterial>()
  const matFor = (s: AppearanceSpec) => {
    const k = specKey(s)
    let m = mats.get(k)
    if (!m) mats.set(k, (m = makeMaterial(s, o.live)))
    return m
  }
  for (const b of bodies) {
    if (o.hidden[b.id]) continue
    const e = o.appearance.get(b.id)
    for (const g of lookGroups(b, e)) {
      if (!g.spec && o.onlyAssigned) continue
      const spec = g.spec ?? o.fallback
      const tile = effectivePreset(spec).tileMm
      const geo = g.faces === 'rest'
        ? faceGeometry(b, (f) => !(e?.faces.has(f)) && !e?.body, tile)
        : faceGeometry(b, (f) => (g.faces as Set<number>).has(f), tile)
      if (!geo) continue
      const mesh = new Mesh(geo, matFor(spec))
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData.bodyId = b.id
      root.add(mesh)
    }
  }
  return root
}

export function disposeModel(root: Group) {
  const mats = new Set<MeshPhysicalMaterial | MeshStandardMaterial>()
  root.traverse((o) => {
    const m = o as Mesh
    if (m.isMesh) { m.geometry.dispose(); mats.add(m.material as MeshPhysicalMaterial) }
  })
  mats.forEach((m) => m.dispose())
}

export function modelBounds(bodies: Body[], hidden: Record<string, true>): Box3 {
  const box = new Box3()
  const v = new Vector3()
  for (const b of bodies) {
    if (hidden[b.id]) continue
    const p = b.mesh.positions
    for (let i = 0; i < p.length; i += 3) box.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]))
  }
  return box
}

// ---------------------------------------------------------------- environment, ground, light

const envCache = new Map<string, DataTexture>()
/** The environment as an equirectangular half float texture (what both the PMREM and the path tracer take). */
export function envTexture(id: string): DataTexture {
  let t = envCache.get(id)
  if (!t) {
    const W = 256, H = 128
    const f = envPixels(id, W, H)
    const h = new Uint16Array(f.length)
    for (let i = 0; i < f.length; i++) h[i] = DataUtils.toHalfFloat(f[i])
    t = new DataTexture(h, W, H, RGBAFormat, HalfFloatType)
    t.mapping = EquirectangularReflectionMapping
    t.minFilter = t.magFilter = LinearFilter
    t.generateMipmaps = false
    t.needsUpdate = true
    envCache.set(id, t)
  }
  return t
}

/** The scene's Z is up, the environments' Y is. */
export const ENV_ROTATION = new Euler(Math.PI / 2, 0, 0)

/** The key light's direction (towards the light) in scene coordinates. */
export function keyDirection(id: string): Vector3 {
  const d = envById(id).key.dir
  return new Vector3(d[0], -d[2], d[1]).normalize()
}

export interface GroundOptions {
  /** the path tracer lights the plane itself, the raster renderers need a shadow catcher and a mirror image */
  mode: 'raster' | 'pt'
}

/** Ground under the model (a shadow catcher and/or a mirror). Returns null when neither is wanted. `mirror` is filled with a flipped copy of the model for the raster mirror. */
export function buildGround(bounds: Box3, s: RenderSettings, o: GroundOptions, makeMirror?: () => Group): Group | null {
  if (!s.shadow && !s.reflection) return null
  const g = new Group()
  g.name = 'render-ground'
  const size = Math.max(bounds.getSize(new Vector3()).length() * 6, 100)
  const cx = (bounds.min.x + bounds.max.x) / 2, cy = (bounds.min.y + bounds.max.y) / 2, z = bounds.min.z
  const plane = new PlaneGeometry(size, size)
  if (o.mode === 'pt') {
    const m = new MeshPhysicalMaterial({ color: new Color(s.backdropColor), roughness: s.reflection ? 0.08 : 0.9, metalness: 0, clearcoat: 0 })
    const p = new Mesh(plane, m)
    p.position.set(cx, cy, z - 0.01)
    g.add(p)
    return g
  }
  if (s.reflection && makeMirror) {
    const mirror = makeMirror()
    mirror.scale.z = -1
    mirror.position.z = 2 * z
    mirror.traverse((c) => { (c as Mesh).castShadow = false; (c as Mesh).receiveShadow = false })
    g.add(mirror)
    const floor = new Mesh(plane, new MeshStandardMaterial({ color: new Color(s.backdropColor), roughness: 1, metalness: 0, transparent: true, opacity: 0.86, emissive: new Color(s.backdropColor), emissiveIntensity: 0.9 }))
    floor.position.set(cx, cy, z - 0.005)
    floor.renderOrder = 1
    g.add(floor)
  }
  if (s.shadow) {
    const catcher = new Mesh(plane, new ShadowMaterial({ opacity: 0.38 }))
    catcher.position.set(cx, cy, z + 0.01)
    catcher.receiveShadow = true
    catcher.renderOrder = 2
    g.add(catcher)
  }
  return g
}

/** The light that casts the raster shadow, aimed at the model's bounds. */
export function buildKeyLight(bounds: Box3, envId: string): DirectionalLight {
  const c = bounds.getCenter(new Vector3())
  const r = Math.max(bounds.getSize(new Vector3()).length() / 2, 1)
  const l = new DirectionalLight(0xffffff, envById(envId).key.intensity)
  l.position.copy(c).addScaledVector(keyDirection(envId), r * 4)
  l.target.position.copy(c)
  l.castShadow = true
  l.shadow.mapSize.set(2048, 2048)
  const cam = l.shadow.camera
  cam.left = cam.bottom = -r * 1.8
  cam.right = cam.top = r * 1.8
  cam.near = 0.1
  cam.far = r * 12
  l.shadow.bias = -0.0005
  l.shadow.normalBias = r * 0.002
  l.shadow.radius = 4
  l.updateMatrixWorld()
  l.target.updateMatrixWorld()
  return l
}
