/**
 * Viewport layer for the hair preview: one merged strand geometry (opaque, solid shaded) and the wall (muted translucent red).
 *
 * Ambient occlusion and thin strands do not mix: the strands are far thinner than the AO kernel, so they speckle. While AO is
 * on, the hair therefore lives on its own camera layer, stays out of the composer's depth / normal / AO passes and is drawn
 * afterwards by `HairOverlayPass`, depth-tested against a depth-only copy of the bodies.
 */
import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, DoubleSide, MeshBasicMaterial, type Light, type Object3D } from 'three'
import { useUi } from '@/store/ui'
import type { Mesh3 } from './wall'
import { useHairView } from './store'

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
export const useHairSplit = () => useUi((s) => s.ssao && !s.section.on)

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
