/**
 * The look of the 3D view: soft studio reflections on the bodies, a gentle light gradient across their faces, a real contact shadow on
 * the ground (the bodies seen from below, blurred), and a screen-space outline round selected bodies. All of it is left out where the
 * picture is drawn on the CPU (see richGraphics).
 */
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  Color, DoubleSide, LinearFilter, Material, Mesh, MeshBasicMaterial, Object3D, OrthographicCamera, PMREMGenerator, PlaneGeometry, RGBAFormat, Scene, ShaderMaterial,
  Vector2, WebGLRenderTarget, type Texture, type WebGLRenderer,
} from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { richGraphics } from '@/app/glass'
import { useVpColors } from './colors'

/** An image-based light (a small neutral room) so the bodies get a faint specular sheen instead of reading as flat clay. */
export function StudioEnv() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    if (!richGraphics()) return
    const pm = new PMREMGenerator(gl)
    const room = new RoomEnvironment()
    const tex: Texture = pm.fromScene(room, 0.04).texture
    scene.environment = tex
    scene.environmentIntensity = 0.35
    invalidate()
    return () => { scene.environment = null; tex.dispose(); pm.dispose(); room.dispose() }
  }, [gl, scene, invalidate])
  return null
}

// ---------------------------------------------------------------- the light gradient on the bodies

/** What the body shader needs to know about the scene: the floor, the top and the middle of everything that stands on it. */
export const studioUniforms = { uZ0: { value: 0 }, uZ1: { value: 20 }, uC: { value: new Vector2() }, uR: { value: 20 } }

/**
 * Patches a body material: vertical faces get lighter towards the top, top faces are brightest in the middle and fall off towards the
 * rim. (A plain lit face in an orthographic view is one flat colour.)
 */
export function studioPatch(m: Material) {
  if (!richGraphics()) return
  m.customProgramCacheKey = () => 'studio-gradient'
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, studioUniforms)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSW;\nvarying vec3 vSN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSN = normalize(mat3(modelMatrix) * normal);')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSW;\nvarying vec3 vSN;\nuniform float uZ0;\nuniform float uZ1;\nuniform vec2 uC;\nuniform float uR;')
      .replace('#include <dithering_fragment>', `
      {
        float t = clamp((vSW.z - uZ0) / max(uZ1 - uZ0, 1e-3), 0.0, 1.0);
        float top = clamp(vSN.z, 0.0, 1.0);
        float rad = clamp(length(vSW.xy - uC) / max(uR, 1e-3), 0.0, 1.0);
        float g = (1.0 - top) * mix(0.80, 1.0, t) + top * (1.0 - 0.12 * rad);
        gl_FragColor.rgb = gl_FragColor.rgb * g;
      }
      #include <dithering_fragment>`)
  }
  m.needsUpdate = true
}

// ---------------------------------------------------------------- render only some objects

/** Draws the scene with only the objects `keep` accepts, all in one override material, into `target`; everything is put back after. */
function renderSubset(gl: WebGLRenderer, scene: Scene, camera: OrthographicCamera | import('three').Camera, keep: (o: Object3D) => boolean, material: Material, target: WebGLRenderTarget) {
  const hidden: Object3D[] = []
  scene.traverse((o) => {
    const r = o as Mesh & { isLine?: boolean; isPoints?: boolean; isSprite?: boolean }
    if ((r.isMesh || r.isLine || r.isPoints || r.isSprite) && o.visible && !keep(o)) { o.visible = false; hidden.push(o) }
  })
  const bg = scene.background, env = scene.environment, over = scene.overrideMaterial
  const prevClear = gl.getClearColor(new Color()), prevAlpha = gl.getClearAlpha(), prevTarget = gl.getRenderTarget()
  scene.background = null
  scene.environment = null
  scene.overrideMaterial = material
  gl.setRenderTarget(target)
  gl.setClearColor(0x000000, 1)
  gl.clear()
  gl.render(scene, camera)
  gl.setRenderTarget(prevTarget)
  gl.setClearColor(prevClear, prevAlpha)
  scene.overrideMaterial = over
  scene.background = bg
  scene.environment = env
  for (const o of hidden) o.visible = true
}

// ---------------------------------------------------------------- the contact shadow

const depthVert = /* glsl */ `varying float vH; void main() { vH = (modelMatrix * vec4(position, 1.0)).z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const depthFrag = /* glsl */ `varying float vH; uniform float uH; void main() { gl_FragColor = vec4(vec3(1.0 - clamp(vH / uH, 0.0, 1.0)), 1.0); }`
const blurVert = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`
const blurFrag = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 uDir;
void main() {
  float s = 0.0;
  float w[5]; w[0] = 0.2270; w[1] = 0.1945; w[2] = 0.1216; w[3] = 0.0540; w[4] = 0.0162;
  for (int i = -4; i <= 4; i++) s += texture2D(tMap, vUv + uDir * float(i)).r * w[i < 0 ? -i : i];
  gl_FragColor = vec4(vec3(s), 1.0);
}`
const showVert = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const showFrag = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tMap;
uniform float uOpacity;
void main() {
  // the shadow camera looks up from below, so the picture is mirrored left to right
  float a = texture2D(tMap, vec2(1.0 - vUv.x, vUv.y)).r;
  a = smoothstep(0.02, 0.85, a) * uOpacity;
  vec2 e = min(vUv, 1.0 - vUv);
  a *= smoothstep(0.0, 0.08, min(e.x, e.y));
  if (a < 0.004) discard;
  gl_FragColor = vec4(vec3(0.0), a);
}`

const RES = 512
const IS_BODY = (o: Object3D) => !!o.userData.casts

/**
 * A soft shadow on the ground, as in a product shot: the bodies are drawn once from below, darker the closer to the floor they are,
 * blurred, and laid on the ground. It is made again only when the bodies change.
 */
export function ContactShadow() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const invalidate = useThree((s) => s.invalidate)
  const geometry = useDoc((s) => s.geometry)
  const hidden = useUi((s) => s.hiddenIds)
  const sketching = useUi((s) => s.sketchMode)
  const theme = useUi((s) => s.theme)
  const rich = richGraphics()
  const dirty = useRef(true)
  const mesh = useRef<Mesh>(null)

  const box = useMemo(() => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, heavy = false
    for (const b of geometry) {
      if (hidden[b.id]) continue
      if (b.mesh.lod || b.mesh.indices.length > 450_000) { heavy = true; continue }
      const p = b.mesh.positions
      for (let i = 0; i < p.length; i += 3) {
        if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]
        if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1]
        if (p[i + 2] < z0) z0 = p[i + 2]; if (p[i + 2] > z1) z1 = p[i + 2]
      }
    }
    return x0 === Infinity || heavy ? null : { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hx: Math.max((x1 - x0) / 2, 0.5), hy: Math.max((y1 - y0) / 2, 0.5), z0, z1 }
  }, [geometry, hidden])

  // the light gradient on the bodies follows the same box
  useEffect(() => {
    if (!box) return
    studioUniforms.uZ0.value = box.z0
    studioUniforms.uZ1.value = box.z1
    studioUniforms.uC.value.set(box.cx, box.cy)
    studioUniforms.uR.value = Math.max(box.hx, box.hy) * 1.15
    invalidate()
  }, [box, invalidate])

  const gfx = useMemo(() => {
    const opts = { minFilter: LinearFilter, magFilter: LinearFilter, format: RGBAFormat, depthBuffer: true }
    const a = new WebGLRenderTarget(RES, RES, opts), b = new WebGLRenderTarget(RES, RES, { ...opts, depthBuffer: false })
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 100)
    const depth = new ShaderMaterial({ vertexShader: depthVert, fragmentShader: depthFrag, side: DoubleSide, uniforms: { uH: { value: 20 } } })
    const blur = new ShaderMaterial({ vertexShader: blurVert, fragmentShader: blurFrag, uniforms: { tMap: { value: null }, uDir: { value: new Vector2() } }, depthTest: false })
    const quad = new Mesh(new PlaneGeometry(2, 2), blur)
    const quadScene = new Scene()
    quadScene.add(quad)
    const show = new ShaderMaterial({ vertexShader: showVert, fragmentShader: showFrag, transparent: true, depthWrite: false, uniforms: { tMap: { value: a.texture }, uOpacity: { value: 0.55 } } })
    return { a, b, cam, depth, blur, quad, quadScene, show }
  }, [])
  useEffect(() => () => { gfx.a.dispose(); gfx.b.dispose(); gfx.depth.dispose(); gfx.blur.dispose(); gfx.show.dispose(); gfx.quad.geometry.dispose() }, [gfx])

  useEffect(() => {
    dirty.current = true
    invalidate()
    // the bodies can reach the scene a moment after the document says so
    const t = setTimeout(() => { dirty.current = true; invalidate() }, 400)
    return () => clearTimeout(t)
  }, [box, theme, invalidate])

  useFrame(() => {
    if (!rich || !box || sketching || !dirty.current || !mesh.current) return
    dirty.current = false
    const size = Math.max(box.hx, box.hy)
    const pad = size * 0.9
    const hw = box.hx + pad, hh = box.hy + pad
    const H = Math.max(box.z1 - Math.min(box.z0, 0), 1) * 1.6
    gfx.cam.left = -hw; gfx.cam.right = hw; gfx.cam.top = hh; gfx.cam.bottom = -hh
    gfx.cam.near = 0; gfx.cam.far = H + 10
    gfx.cam.position.set(box.cx, box.cy, -1)
    gfx.cam.up.set(0, 1, 0)
    gfx.cam.lookAt(box.cx, box.cy, 10)
    gfx.cam.updateProjectionMatrix()
    gfx.cam.updateMatrixWorld()
    gfx.depth.uniforms.uH.value = H
    const was = mesh.current.visible
    mesh.current.visible = false
    renderSubset(gl, scene, gfx.cam, IS_BODY, gfx.depth, gfx.a)
    mesh.current.visible = was
    // two blur passes each way: the shadow spreads about a tenth of its size
    const px = (0.9 * size) / (2 * hw) * 1.0
    for (let i = 0; i < 2; i++) {
      for (const [src, dst, dir] of [[gfx.a, gfx.b, new Vector2(px / 4 / (i + 1), 0)], [gfx.b, gfx.a, new Vector2(0, px / 4 / (i + 1) * (hw / hh))]] as [WebGLRenderTarget, WebGLRenderTarget, Vector2][]) {
        gfx.blur.uniforms.tMap.value = src.texture
        gfx.blur.uniforms.uDir.value.copy(dir)
        const prev = gl.getRenderTarget()
        gl.setRenderTarget(dst)
        gl.render(gfx.quadScene, gfx.cam)
        gl.setRenderTarget(prev)
      }
    }
    mesh.current.position.set(box.cx, box.cy, -0.03)
    mesh.current.scale.set(hw, hh, 1)
    gfx.show.uniforms.uOpacity.value = theme === 'dark' ? 0.8 : 0.34
    invalidate()
  })

  if (!rich || !box || sketching) return null
  return (
    <mesh ref={mesh} renderOrder={-2} material={gfx.show} raycast={() => null} frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
    </mesh>
  )
}

// ---------------------------------------------------------------- the selection outline

const quadVert = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`
const outlineFrag = /* glsl */ `
uniform sampler2D tMask;
uniform vec2 uTexel;
uniform vec3 uColor;
void main() {
  vec2 uv = gl_FragCoord.xy * uTexel;
  float c = texture2D(tMask, uv).r;
  if (c > 0.5) discard;
  float rim = 0.0;
  for (int i = 0; i < 16; i++) {
    float a = 6.2831853 * float(i) / 16.0;
    vec2 d = vec2(cos(a), sin(a)) * uTexel;
    rim = max(rim, texture2D(tMask, uv + d * 1.5).r);
  }
  float aa = rim * 0.95;
  if (aa < 0.01) discard;
  gl_FragColor = vec4(uColor, min(aa, 1.0));
}`

/** A crisp rim round every body flagged `userData.selected`, found on the mask of those bodies: even on long, thin parts. */
export function SelectionOutline() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const colors = useVpColors()
  const rt = useMemo(() => new WebGLRenderTarget(4, 4, { minFilter: LinearFilter, magFilter: LinearFilter }), [])
  const mask = useMemo(() => new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide }), [])
  const mat = useMemo(() => new ShaderMaterial({ vertexShader: quadVert, fragmentShader: outlineFrag, transparent: true, depthTest: false, depthWrite: false, uniforms: { tMask: { value: rt.texture }, uTexel: { value: new Vector2() }, uColor: { value: new Color() } } }), [rt])
  const quad = useRef<Mesh>(null)
  useEffect(() => () => { rt.dispose(); mask.dispose(); mat.dispose() }, [rt, mask, mat])
  const pr = useRef(1)
  useFrame(({ camera, size }) => {
    const q = quad.current
    if (!q || !richGraphics()) return
    let any = false
    scene.traverse((o) => { if (!any && o.userData.selected && o.visible) any = true })
    q.visible = false
    if (!any) return
    const dpr = gl.getPixelRatio()
    const w = Math.max(2, Math.round(size.width * dpr)), h = Math.max(2, Math.round(size.height * dpr))
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h)
    pr.current = dpr
    renderSubset(gl, scene, camera, (o) => !!o.userData.selected, mask, rt)
    mat.uniforms.uTexel.value.set(1 / w, 1 / h)
    mat.uniforms.uColor.value.set(colors.sel)
    q.visible = true
  }, -1)
  return (
    <mesh ref={quad} renderOrder={900} frustumCulled={false} raycast={() => null} material={mat} userData={{ noAo: true }}>
      <planeGeometry args={[2, 2]} />
    </mesh>
  )
}

