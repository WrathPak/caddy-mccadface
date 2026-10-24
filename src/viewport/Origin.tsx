/** Origin axes + planes and construction planes. Planes are sized to the scene's bounds and hidden until their eye is switched on. */
import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import { DoubleSide, type Quaternion } from 'three'
import { useDoc } from '@/doc/store'
import { PLANE_FEATURES, usePlanes } from '@/sketch/planes'
import { planeQuaternion } from '@/sketch/plane'
import { useUi } from '@/store/ui'
import { bbox } from '@/kernel/types'
import { useVpColors } from './colors'
import { useInstances } from '@/assembly/place'
import type { Instance } from '@/assembly/instances'

/** Rounds up to a tidy value (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 x 10^n) so the plane edges land on round numbers. */
export function niceCeil(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (p * m >= v - 1e-9) return p * m
  return p * 10
}

/** Half-size of the origin planes: the farthest geometry from the origin plus a margin (a small default for an empty scene). */
export function sceneHalfSize(bodies: { mesh: { positions: Float32Array } }[]): number {
  let r = 0
  for (const b of bodies) {
    const bb = bbox(b.mesh.positions)
    for (let k = 0; k < 3; k++) r = Math.max(r, Math.abs(bb.min[k]), Math.abs(bb.max[k]))
  }
  return Math.max(15, niceCeil(r * 1.1))
}

/** Like sceneHalfSize, for the bodies where they are drawn (instances of components are placed). */
export function instancesHalfSize(instances: Instance[]): number {
  let r = 0
  for (const i of instances) {
    const p = i.body.mesh.positions, m = i.world
    for (let k = 0; k < p.length; k += 3) {
      const x = m[0] * p[k] + m[4] * p[k + 1] + m[8] * p[k + 2] + m[12]
      const y = m[1] * p[k] + m[5] * p[k + 1] + m[9] * p[k + 2] + m[13]
      const z = m[2] * p[k] + m[6] * p[k + 1] + m[10] * p[k + 2] + m[14]
      r = Math.max(r, Math.abs(x), Math.abs(y), Math.abs(z))
    }
  }
  return Math.max(15, niceCeil(r * 1.1))
}

export function useSceneHalfSize() {
  const instances = useInstances()
  return useMemo(() => instancesHalfSize(instances), [instances])
}

/** Rectangle outline (closed) of a square plane of half-size `s`. */
const outline = (s: number): [number, number, number][] => [[-s, -s, 0], [s, -s, 0], [s, s, 0], [-s, s, 0], [-s, -s, 0]]

function PlaneQuad({ s, color, fill, edge, quaternion, position, order }: {
  s: number; color: string; fill: number; edge: number
  quaternion?: Quaternion; position?: [number, number, number]; order?: number
}) {
  return (
    <group quaternion={quaternion} position={position} renderOrder={order ?? -2}>
      <mesh raycast={() => null}>
        <planeGeometry args={[s * 2, s * 2]} />
        <meshBasicMaterial color={color} transparent opacity={fill} side={DoubleSide} depthWrite={false} />
      </mesh>
      <Line points={outline(s)} color={color} lineWidth={1} transparent opacity={edge} depthWrite={false} raycast={() => null} />
    </group>
  )
}

export function Origin() {
  const c = useVpColors()
  const hidden = useUi((s) => s.hiddenIds)
  const s = useSceneHalfSize()
  const planes: { id: string; rot: [number, number, number]; color: string }[] = [
    { id: 'planeXY', rot: [0, 0, 0], color: c.axisZ },
    { id: 'planeXZ', rot: [Math.PI / 2, 0, 0], color: c.axisY },
    { id: 'planeYZ', rot: [0, Math.PI / 2, 0], color: c.axisX },
  ]
  const axes: { id: string; to: [number, number, number]; color: string }[] = [
    { id: 'axisX', to: [s * 1.15, 0, 0], color: c.axisX },
    { id: 'axisY', to: [0, s * 1.15, 0], color: c.axisY },
    { id: 'axisZ', to: [0, 0, s * 1.15], color: c.axisZ },
  ]
  return (
    <group renderOrder={-2} name="origin">
      {planes.filter((p) => !hidden[p.id]).map((p) => (
        <group key={p.id} name={p.id} rotation={p.rot}>
          <PlaneQuad s={s} color={p.color} fill={0.06} edge={0.55} />
        </group>
      ))}
      {axes.filter((a) => !hidden[a.id]).map((a) => (
        <Line key={a.id} points={[[0, 0, 0], a.to]} color={a.color} lineWidth={1.5} raycast={() => null} />
      ))}
    </group>
  )
}

/** Offset (construction) planes, plus the open Offset Plane dialog's preview plane. */
export function ConstructionPlanes() {
  const colors = useVpColors()
  const data = usePlanes((st) => st.data)
  const features = useDoc((st) => st.features)
  const rollback = useDoc((st) => st.rollback)
  const hidden = useUi((st) => st.hiddenIds)
  const s = useSceneHalfSize()
  const list = features
    .filter((f, i) => PLANE_FEATURES.has(f.type) && i < rollback && !f.suppressed && data[f.id] && !hidden[f.id])
    .map((f) => ({ id: f.id, plane: data[f.id] }))
  if (data.preview) list.push({ id: 'preview', plane: data.preview })
  return (
    <group name="construction-planes">
      {list.map((p) => (
        <group key={p.id} name={'cplane-' + p.id}>
          <PlaneQuad s={s} color={colors.accent} fill={p.id === 'preview' ? 0.16 : 0.09} edge={0.85} quaternion={planeQuaternion(p.plane)} position={p.plane.origin} />
        </group>
      ))}
    </group>
  )
}
