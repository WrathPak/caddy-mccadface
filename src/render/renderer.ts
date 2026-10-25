/**
 * Offscreen rendering of the document: a progressive path traced still (three-gpu-pathtracer), a rasterized still
 * (MSAA, supersampling, shadow map, PMREM lighting, jittered aperture for depth of field) used when the path tracer is not
 * available, and the turntable animation.
 */
import {
  ACESFilmicToneMapping, Color, Group, PerspectiveCamera, PMREMGenerator, PCFShadowMap, Scene, SRGBColorSpace, Vector3, WebGLRenderer, type Texture,
} from 'three'
import { PhysicalCamera, WebGLPathTracer } from 'three-gpu-pathtracer'
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker'
import type { Body } from '@/kernel/types'
import type { AppearanceMap } from './appearanceMap'
import { denoise } from './denoise'
import { fovForFocal, type RenderSettings } from './settingsCore'
import {
  ENV_ROTATION, buildGround, buildKeyLight, buildModel, disposeModel, envTexture, modelBounds,
} from './sceneBuild'

export interface CameraPose { position: [number, number, number]; quaternion: [number, number, number, number] }

export interface RenderRequest {
  bodies: Body[]
  appearance: AppearanceMap
  hidden: Record<string, true>
  settings: RenderSettings
  camera: CameraPose
  width: number
  height: number
}

export type EngineUsed = 'pathtracer' | 'raster'
export interface RenderOutcome {
  canvas: HTMLCanvasElement
  engine: EngineUsed
  /** why the path tracer was not used, when it was asked for or would have been the default */
  note: string | null
}
export interface Hooks { onProgress(fraction: number, text: string): void; signal: AbortSignal }

export class RenderCancelled extends Error {
  constructor() { super('Render cancelled') }
}
const check = (h: Hooks) => { if (h.signal.aborted) throw new RenderCancelled() }
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

// ---------------------------------------------------------------- capability check

/** Whether the path tracer can run here: WebGL2 with renderable and linearly filterable float textures. */
export function pathTracerSupport(): { ok: true } | { ok: false; reason: string } {
  if (typeof document === 'undefined') return { ok: false, reason: 'No browser canvas is available.' }
  const c = document.createElement('canvas')
  c.width = c.height = 1
  let gl: WebGL2RenderingContext | null = null
  try { gl = c.getContext('webgl2') } catch { gl = null }
  if (!gl) return { ok: false, reason: 'This browser has no WebGL2.' }
  try {
    if (!gl.getExtension('EXT_color_buffer_float')) return { ok: false, reason: 'This graphics driver cannot render to float textures (EXT_color_buffer_float).' }
    if (!gl.getExtension('OES_texture_float_linear')) return { ok: false, reason: 'This graphics driver cannot filter float textures (OES_texture_float_linear).' }
    if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < 4096) return { ok: false, reason: 'The maximum texture size of this graphics driver is too small.' }
    return { ok: true }
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

// ---------------------------------------------------------------- scene

interface Assembled {
  scene: Scene
  /** the model: rotate this for a turntable */
  pivot: Group
  bounds: ReturnType<typeof modelBounds>
  dispose(): void
}

function makeCamera(req: RenderRequest, physical: boolean): PerspectiveCamera {
  const s = req.settings
  const cam = physical ? new PhysicalCamera(fovForFocal(s.focalMm), req.width / req.height, 0.1, 100000) : new PerspectiveCamera(fovForFocal(s.focalMm), req.width / req.height, 0.1, 100000)
  cam.position.fromArray(req.camera.position)
  cam.quaternion.fromArray(req.camera.quaternion)
  cam.up.set(0, 0, 1)
  if (physical) {
    const p = cam as PhysicalCamera
    // without depth of field the aperture is closed down so far that nothing blurs
    p.fStop = s.dof ? s.fStop : 1e5
    p.focusDistance = s.focusDistance
    p.apertureBlades = 6
  }
  cam.updateMatrixWorld(true)
  return cam
}

function assemble(req: RenderRequest, mode: 'raster' | 'pt', renderer?: WebGLRenderer): Assembled {
  const s = req.settings
  const bounds = modelBounds(req.bodies, req.hidden)
  if (bounds.isEmpty()) throw new Error('There is nothing to render. Add a body first.')
  const scene = new Scene()
  const model = buildModel(req.bodies, { appearance: req.appearance, hidden: req.hidden, fallback: { material: 'pla', color: '' } })
  const pivot = new Group()
  const c = bounds.getCenter(new Vector3())
  pivot.position.set(c.x, c.y, 0)
  model.position.set(-c.x, -c.y, 0)
  pivot.add(model)
  scene.add(pivot)
  const extras: { dispose(): void }[] = []
  const ground = buildGround(bounds, s, { mode }, () => {
    const m = buildModel(req.bodies, { appearance: req.appearance, hidden: req.hidden, fallback: { material: 'pla', color: '' } })
    m.position.set(-c.x, -c.y, 0)
    const holder = new Group()
    holder.position.set(c.x, c.y, 0)
    holder.add(m)
    extras.push({ dispose: () => disposeModel(m) })
    return holder
  })
  if (ground) scene.add(ground)
  const env = envTexture(s.env)
  scene.environmentRotation.copy(ENV_ROTATION)
  scene.backgroundRotation.copy(ENV_ROTATION)
  let pm: PMREMGenerator | null = null
  let envMap: Texture = env
  if (mode === 'raster' && renderer) {
    pm = new PMREMGenerator(renderer)
    envMap = pm.fromEquirectangular(env).texture
  }
  scene.environment = envMap
  scene.background = s.backdrop === 'environment' ? envMap : new Color(s.backdropColor)
  if (mode === 'raster' && s.shadow) {
    const key = buildKeyLight(bounds, s.env)
    scene.add(key, key.target)
  }
  return {
    scene, pivot, bounds,
    dispose() {
      disposeModel(model)
      extras.forEach((e) => e.dispose())
      ground?.traverse((o) => { const m = o as { geometry?: { dispose(): void }; material?: { dispose(): void } }; m.geometry?.dispose(); m.material?.dispose() })
      pm?.dispose()
    },
  }
}

function makeRenderer(canvas: HTMLCanvasElement, w: number, h: number, antialias: boolean, exposure: number): WebGLRenderer {
  const r = new WebGLRenderer({ canvas, antialias, preserveDrawingBuffer: true, alpha: false, powerPreference: 'high-performance' })
  r.setPixelRatio(1)
  r.setSize(w, h, false)
  r.outputColorSpace = SRGBColorSpace
  r.toneMapping = ACESFilmicToneMapping
  r.toneMappingExposure = exposure
  return r
}

function lose(r: WebGLRenderer) {
  r.dispose()
  r.forceContextLoss()
}

// ---------------------------------------------------------------- path traced still

async function renderPathTraced(req: RenderRequest, h: Hooks): Promise<HTMLCanvasElement> {
  const { width: w, height: ht, settings: s } = req
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = ht
  const renderer = makeRenderer(canvas, w, ht, false, s.exposure)
  let a: Assembled | null = null
  let tracer: WebGLPathTracer | null = null
  let bvhWorker: GenerateMeshBVHWorker | null = null
  try {
    a = assemble(req, 'pt')
    const camera = makeCamera(req, true)
    tracer = new WebGLPathTracer(renderer)
    tracer.renderDelay = 0
    tracer.minSamples = 0
    tracer.fadeDuration = 0
    tracer.rasterizeScene = false
    tracer.dynamicLowRes = false
    tracer.bounces = 6
    tracer.transmissiveBounces = 8
    tracer.filterGlossyFactor = 0.4
    tracer.tiles.set(2, 2)
    h.onProgress(0, 'Building the scene')
    await tick()
    bvhWorker = new GenerateMeshBVHWorker()
    tracer.setBVHWorker(bvhWorker)
    await tracer.setSceneAsync(a.scene, camera)
    check(h)
    h.onProgress(0.02, 'Compiling the shaders')
    await tick()
    const want = s.samples
    while (tracer.samples < want) {
      check(h)
      tracer.renderSample()
      h.onProgress(0.05 + 0.9 * Math.min(1, tracer.samples / want), `Sample ${Math.min(want, Math.floor(tracer.samples))} of ${want}`)
      await tick()
    }
    tracer.renderSample()
    const out = document.createElement('canvas')
    out.width = w
    out.height = ht
    const ctx = out.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(canvas, 0, 0)
    if (s.denoise) {
      h.onProgress(0.97, 'Denoising')
      await tick()
      const img = ctx.getImageData(0, 0, w, ht)
      const clean = denoise(img, s.denoiseStrength)
      ctx.putImageData(new ImageData(clean as Uint8ClampedArray<ArrayBuffer>, w, ht), 0, 0)
    }
    return out
  } finally {
    tracer?.dispose()
    bvhWorker?.dispose()
    a?.dispose()
    lose(renderer)
  }
}

// ---------------------------------------------------------------- rasterized still

/** Offsets across a unit disc, evenly spread (sunflower pattern): the lens samples for depth of field. */
export function apertureSamples(n: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n), t = i * 2.399963229728653
    out.push([r * Math.cos(t), r * Math.sin(t)])
  }
  return out
}

async function renderRasterized(req: RenderRequest, h: Hooks): Promise<HTMLCanvasElement> {
  const { width: w, height: ht, settings: s } = req
  const probe = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl')
  const maxSize = Math.min(probe ? (probe.getParameter(probe.MAX_RENDERBUFFER_SIZE) as number) : 4096, 8192)
  probe?.getExtension('WEBGL_lose_context')?.loseContext()
  const ss = w * 2 <= maxSize && ht * 2 <= maxSize ? 2 : 1
  const canvas = document.createElement('canvas')
  canvas.width = w * ss
  canvas.height = ht * ss
  const renderer = makeRenderer(canvas, w * ss, ht * ss, true, s.exposure)
  renderer.shadowMap.enabled = s.shadow
  renderer.shadowMap.type = PCFShadowMap
  let a: Assembled | null = null
  try {
    h.onProgress(0, 'Building the scene')
    await tick()
    a = assemble(req, 'raster', renderer)
    const camera = makeCamera(req, false)
    const out = document.createElement('canvas')
    out.width = w
    out.height = ht
    const ctx = out.getContext('2d', { willReadFrequently: true })!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    if (!s.dof) {
      renderer.render(a.scene, camera)
      ctx.drawImage(canvas, 0, 0, w, ht)
      return out
    }
    // depth of field: average renders from points spread over the lens, all aimed at the focus point
    const n = Math.max(8, Math.min(48, s.samples))
    const lens = apertureSamples(n)
    const radius = (s.focalMm / s.fStop) / 2
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
    const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
    const focus = camera.position.clone().addScaledVector(forward, s.focusDistance)
    const origin = camera.position.clone()
    const acc = new Float32Array(w * ht * 4)
    for (let i = 0; i < n; i++) {
      check(h)
      camera.position.copy(origin).addScaledVector(right, lens[i][0] * radius).addScaledVector(up, lens[i][1] * radius)
      camera.up.copy(up)
      camera.lookAt(focus)
      camera.updateMatrixWorld(true)
      renderer.render(a.scene, camera)
      ctx.drawImage(canvas, 0, 0, w, ht)
      const px = ctx.getImageData(0, 0, w, ht).data
      for (let k = 0; k < acc.length; k++) acc[k] += px[k]
      h.onProgress((i + 1) / n, `Lens sample ${i + 1} of ${n}`)
      await tick()
    }
    const img = ctx.createImageData(w, ht)
    for (let k = 0; k < acc.length; k++) img.data[k] = Math.round(acc[k] / n)
    ctx.putImageData(img, 0, 0)
    return out
  } finally {
    a?.dispose()
    lose(renderer)
  }
}

/** Render one still. `engine` auto uses the path tracer when the browser can run it and falls back to the rasterizer otherwise. */
export async function renderStill(req: RenderRequest, h: Hooks): Promise<RenderOutcome> {
  const want = req.settings.engine
  let note: string | null = null
  if (want !== 'raster') {
    const sup = pathTracerSupport()
    if (sup.ok) {
      try {
        return { canvas: await renderPathTraced(req, h), engine: 'pathtracer', note: null }
      } catch (e) {
        if (e instanceof RenderCancelled) throw e
        if (e instanceof Error && e.message.startsWith('There is nothing')) throw e
        note = `The path tracer failed (${e instanceof Error ? e.message : String(e)}).`
      }
    } else note = sup.reason
  }
  check(h)
  const canvas = await renderRasterized(req, h)
  return { canvas, engine: 'raster', note: want === 'raster' ? null : `${note} Rendered with the rasterizer instead, without the path tracer's global lighting.` }
}

export const canvasToPng = (c: HTMLCanvasElement): Promise<Uint8Array> =>
  new Promise((resolve, reject) => c.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('Could not encode the PNG'))), 'image/png'))

// ---------------------------------------------------------------- turntable

const WEBM_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
export function webmSupport(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  return WEBM_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null
}

/** Records the model turning once around its vertical axis. Frame n shows the model at n / frames of a turn, however long rendering takes. */
export async function renderTurntable(req: RenderRequest, h: Hooks): Promise<Uint8Array> {
  const mime = webmSupport()
  if (!mime) throw new Error('This browser cannot record WebM video.')
  const s = req.settings
  const t = s.turntable
  const frames = Math.max(2, Math.round(t.seconds * t.fps))
  const canvas = document.createElement('canvas')
  canvas.width = t.width
  canvas.height = t.height
  const renderer = makeRenderer(canvas, t.width, t.height, true, s.exposure)
  renderer.shadowMap.enabled = s.shadow
  renderer.shadowMap.type = PCFShadowMap
  let a: Assembled | null = null
  try {
    a = assemble({ ...req, width: t.width, height: t.height }, 'raster', renderer)
    const camera = makeCamera({ ...req, width: t.width, height: t.height }, false)
    const stream = canvas.captureStream(0)
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void }
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    const done = new Promise<void>((resolve) => { rec.onstop = () => resolve() })
    rec.start()
    for (let i = 0; i < frames; i++) {
      if (h.signal.aborted) { rec.stop(); await done; throw new RenderCancelled() }
      a.pivot.rotation.z = (i / frames) * Math.PI * 2
      a.pivot.updateMatrixWorld(true)
      renderer.render(a.scene, camera)
      track.requestFrame?.()
      h.onProgress((i + 1) / frames, `Frame ${i + 1} of ${frames}`)
      // frames reach the recorder at the video's frame rate, so the clip lasts as long as asked
      await new Promise<void>((r) => setTimeout(r, 1000 / t.fps))
    }
    rec.stop()
    await done
    return new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())
  } finally {
    a?.dispose()
    lose(renderer)
  }
}
