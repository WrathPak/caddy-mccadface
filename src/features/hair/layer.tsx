/** Viewport layer for the hair preview: one merged strand geometry (light) and the wall (muted translucent red). */
import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, DoubleSide } from 'three'
import type { Mesh3 } from './wall'
import { useHairView } from './store'

function useGeo(m: Mesh3 | null | undefined) {
  const geo = useMemo(() => {
    if (!m) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(m.positions, 3))
    g.setIndex(new BufferAttribute(m.indices, 1))
    return g
  }, [m])
  useEffect(() => () => geo?.dispose(), [geo])
  return geo
}

export function HairPreviewLayer() {
  const result = useHairView((s) => s.result)
  const visible = useHairView((s) => s.visible)
  const { invalidate } = useThree()
  const strands = useGeo(result?.strands)
  const wall = useGeo(result?.wall)
  useEffect(() => { invalidate() }, [strands, wall, visible, invalidate])
  if (!visible) return null
  return (
    <>
      {strands && (
        <mesh geometry={strands} renderOrder={3} raycast={() => null}>
          <meshStandardMaterial color="#efe9da" roughness={0.55} flatShading side={DoubleSide} />
        </mesh>
      )}
      {wall && (
        <mesh geometry={wall} renderOrder={4} raycast={() => null}>
          <meshStandardMaterial color="#b0463e" roughness={0.7} flatShading transparent opacity={0.42} side={DoubleSide} depthWrite={false} />
        </mesh>
      )}
    </>
  )
}
