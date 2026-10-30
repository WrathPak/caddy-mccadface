/**
 * Viewport layer for the hair preview: one merged strand geometry (opaque, solid shaded) and the wall (muted translucent red).
 *
 * Ambient occlusion and thin strands do not mix: the strands are far thinner than the AO kernel, so they speckle. While AO is
 * on, the hair therefore lives on its own camera layer, stays out of the composer's depth / normal / AO passes and is drawn
 * afterwards by `HairOverlayPass`, depth-tested against a depth-only copy of the bodies.
 */
import { markGrab } from '@/viewport/touchGrab'
import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, DoubleSide, MeshBasicMaterial, Plane, Raycaster, Vector2, Vector3, type Light, type Object3D } from 'three'
import { useUi } from '@/store/ui'
import type { Mesh3 } from './wall'
import { useHairView } from './store'
import type { V3 } from './schema'
import { add, cross, mul, norm, perp } from './vec'

export const HAIR_LAYER = 1

/** Indexed geometry with vertex normals (the strand tubes and the wall share vertices between triangles). */
function useGeo(m: Mesh3 | null | undefined) {
  const geo = useMemo(() => {
    if (!m) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(m.positions, 3))
    g.setIndex(new BufferAttribute(m.indices, 1))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }, [m])
  useEffect(() => () => geo?.dispose(), [geo])
  return geo
}

/** True while the composer (ambient occlusion) is on: the hair is then drawn by HairOverlayPass instead of the main pass. */
export const useHairSplit = () => useUi((s) => s.aoActive)

export function HairPreviewLayer() {
  const result = useHairView((s) => s.result)
  const visible = useHairView((s) => s.visible)
  const split = useHairSplit()
  const { invalidate } = useThree()
  const strands = useGeo(result?.strands)
  const wall = useGeo(result?.wall)
  useEffect(() => { invalidate() }, [strands, wall, visible, split, invalidate])
  if (!visible) return null
  const layers = split ? HAIR_LAYER : 0
  return (
    <group name="hair-preview">
      {strands && (
        <mesh name="hair-strands" geometry={strands} renderOrder={3} raycast={() => null} layers={layers} userData={{ noAo: true }}>
          <meshStandardMaterial color="#efe9da" roughness={0.6} metalness={0} side={DoubleSide} />
        </mesh>
      )}
      {wall && (
        <mesh name="hair-wall" geometry={wall} renderOrder={4} raycast={() => null} layers={layers} userData={{ noAo: true }}>
          <meshStandardMaterial color="#b0463e" roughness={0.7} transparent opacity={0.42} side={DoubleSide} depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}

const DEPTH_ONLY = new MeshBasicMaterial({ colorWrite: false, side: DoubleSide })

/**
 * Second render after the post-processing composer: a depth-only pass of the bodies, then the hair layer (lit by the scene's
 * lights). Mounted only while the composer is active (it takes over the render loop, like the composer does).
 */
export function HairOverlayPass() {
  const { gl, scene, camera } = useThree()
  useFrame(() => {
    const hair = scene.getObjectByName('hair-preview')
    if (!hair || !hair.visible || !hair.children.length) return
    const tops: Object3D[] = scene.children
    const shown = tops.map((o) => o.visible)
    const auto = gl.autoClear
    const background = scene.background
    gl.autoClear = false
    scene.background = null // a colour background would force a clear of the composer's image
    try {
      gl.clearDepth()
      // 1. depth of the bodies only (the composer drew the colour)
      tops.forEach((o) => { o.visible = o.name === 'bodies' })
      scene.overrideMaterial = DEPTH_ONLY
      gl.render(scene, camera)
      scene.overrideMaterial = null
      // 2. the hair, lit by the scene lights
      tops.forEach((o) => { o.visible = (o as Light).isLight || o === hair })
      camera.layers.enable(HAIR_LAYER)
      gl.render(scene, camera)
    } finally {
      scene.overrideMaterial = null
      tops.forEach((o, i) => { o.visible = shown[i] })
      camera.layers.disable(HAIR_LAYER)
      scene.background = background
      gl.autoClear = auto
    }
  }, 2)
  return null
}

// ---------------------------------------------------------------- direction arrows

/** Line segments for arrows: a shaft and two barbs each. */
function arrowLines(g: Float32Array, len: number): Float32Array {
  const n = g.length / 6
  const out = new Float32Array(n * 18)
  const barb = len * 0.28
  for (let i = 0; i < n; i++) {
    const o: V3 = [g[i * 6], g[i * 6 + 1], g[i * 6 + 2]], d: V3 = [g[i * 6 + 3], g[i * 6 + 4], g[i * 6 + 5]]
    const tip = add(o, mul(d, len))
    const side = perp(d)
    const up = cross(d, side)
    const back = add(tip, mul(d, -barb))
    const pts = [o, tip, tip, add(back, mul(side, barb * 0.55)), tip, add(back, mul(up, barb * 0.55))]
    pts.forEach((p, k) => out.set(p, i * 18 + k * 3))
  }
  return out
}

/** Arrows on the selected faces showing where strands will point, plus the draggable arrow for a fixed direction. */
export function HairDirectionOverlay() {
  const glyphs = useHairView((s) => s.glyphs)
  const show = useHairView((s) => s.showGlyphs)
  const fixed = useHairView((s) => s.fixed)
  const { invalidate, camera, gl } = useThree()
  const len = glyphs ? clampLen(glyphs.size * 0.07) : 3
  const geo = useMemo(() => {
    if (!glyphs || !glyphs.data.length) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(arrowLines(glyphs.data, len), 3))
    return g
  }, [glyphs, len])
  useEffect(() => () => geo?.dispose(), [geo])
  useEffect(() => { invalidate() }, [geo, show, fixed, invalidate])
  const handle = glyphs && fixed ? add(glyphs.centre, mul(norm(fixed.dir), glyphs.size * 0.45)) : null
  const shaft = useMemo(() => {
    if (!glyphs || !handle) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(Float32Array.from([...glyphs.centre, ...handle]), 3))
    return g
  }, [glyphs, handle?.[0], handle?.[1], handle?.[2]]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => shaft?.dispose(), [shaft])

  const drag = (e: { stopPropagation(): void }) => {
    e.stopPropagation()
    markGrab()
    if (!glyphs || !fixed) return
    const rc = new Raycaster()
    const centre = new Vector3(...glyphs.centre)
    const move = (ev: PointerEvent) => {
      const r = gl.domElement.getBoundingClientRect()
      rc.setFromCamera(new Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera)
      const n = new Vector3()
      camera.getWorldDirection(n)
      const hit = new Vector3()
      const at = new Vector3(...(handle as V3))
      if (!rc.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(n, at), hit)) return
      const d = hit.sub(centre)
      if (d.length() < 1e-6) return
      d.normalize()
      const snap = (x: number) => +x.toFixed(3)
      useHairView.getState().fixed?.set([snap(d.x), snap(d.y), snap(d.z)])
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!show) return null
  return (
    <group name="hair-directions">
      {geo && (
        <lineSegments geometry={geo} renderOrder={20} raycast={() => null}>
          <lineBasicMaterial color="#ffb347" depthTest={false} transparent />
        </lineSegments>
      )}
      {handle && shaft && glyphs && (
        <>
          <lineSegments geometry={shaft} renderOrder={21} raycast={() => null}>
            <lineBasicMaterial color="#ffb347" depthTest={false} transparent />
          </lineSegments>
          <mesh position={handle} renderOrder={22} userData={{ handle: true }} onPointerDown={drag as never} onPointerOver={() => { gl.domElement.style.cursor = 'grab' }} onPointerOut={() => { gl.domElement.style.cursor = '' }}>
            <sphereGeometry args={[Math.max(0.8, glyphs.size * 0.025), 16, 12]} />
            <meshBasicMaterial color="#ffb347" depthTest={false} transparent />
          </mesh>
        </>
      )}
    </group>
  )
}

const clampLen = (x: number) => Math.min(8, Math.max(1.5, x))
