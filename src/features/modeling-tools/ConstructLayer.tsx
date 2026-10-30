/** Viewport layer of the modeling tools: construction axes and points, cosmetic threads, instance / hole markers, and the click targets (planes, axes, points, vertices) for reference fields. */
import { useMemo, useState } from 'react'
import { Line } from '@react-three/drei'
import { DoubleSide, Quaternion, Vector3 } from 'three'
import { useDoc } from '@/doc/store'
import { originPlane, planeQuaternion } from '@/sketch/plane'
import { PLANE_FEATURES, usePlanes } from '@/sketch/planes'
import { useUi } from '@/store/ui'
import { useVpColors } from '@/viewport/colors'
import { useSceneHalfSize } from '@/viewport/Origin'
import type { Vec3 } from '@/kernel/types'
import { useConstruct } from './geo'
import { useMarkers } from './markers'

const noRay = () => null

function Dot({ at, r, color, hot, onClick, onHover, hollow }: { at: Vec3; r: number; color: string; hot?: boolean; onClick?: () => void; onHover?: (on: boolean) => void; hollow?: boolean }) {
  return (
    <mesh
      position={at} renderOrder={40}
      raycast={onClick ? undefined : noRay}
      onClick={onClick ? (e) => { e.stopPropagation(); onClick() } : undefined}
      onPointerOver={onHover ? (e) => { e.stopPropagation(); onHover(true) } : undefined}
      onPointerOut={onHover ? () => onHover(false) : undefined}
    >
      <sphereGeometry args={[hot ? r * 1.5 : r, 14, 10]} />
      <meshBasicMaterial color={color} depthTest={false} transparent opacity={hollow ? 0.35 : 1} />
    </mesh>
  )
}

function CosmeticThreads({ r }: { r: number }) {
  const threads = useConstruct((s) => s.threads)
  const colors = useVpColors()
  const hidden = useUi((s) => s.hiddenIds)
  void r
  return (
    <>
      {Object.entries(threads).flatMap(([fid, list]) => (hidden[fid] ? [] : list.map((t, i) => {
        const n = new Vector3(...t.dir).normalize()
        const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), n)
        const ring = (z: number) => Array.from({ length: 49 }, (_, k): Vec3 => [(t.major / 2) * Math.cos((k / 48) * Math.PI * 2), (t.major / 2) * Math.sin((k / 48) * Math.PI * 2), z])
        return (
          <group key={fid + i} position={t.origin} quaternion={q} name={'thread-' + fid}>
            <Line points={ring(0.02)} color={colors.accent} lineWidth={1} dashed dashSize={0.5} gapSize={0.35} raycast={noRay} />
            <Line points={ring(-t.length)} color={colors.accent} lineWidth={1} dashed dashSize={0.5} gapSize={0.35} raycast={noRay} />
            {[0, 1, 2, 3].map((k) => {
              const a = (k * Math.PI) / 2
              return <Line key={k} points={[[(t.major / 2) * Math.cos(a), (t.major / 2) * Math.sin(a), 0], [(t.major / 2) * Math.cos(a), (t.major / 2) * Math.sin(a), -t.length]]} color={colors.accent} lineWidth={1} dashed dashSize={0.5} gapSize={0.35} raycast={noRay} />
            })}
          </group>
        )
      })))}
    </>
  )
}

export function ConstructLayer() {
  const colors = useVpColors()
  const selWhite = colors.custom ? colors.sel : '#ffffff'
  const half = useSceneHalfSize()
  const r = half * 0.012
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const geometry = useDoc((s) => s.geometry)
  const hidden = useUi((s) => s.hiddenIds)
  const pick = useUi((s) => s.pickKinds)
  const selection = useUi((s) => s.selection)
  const sketching = useUi((s) => s.sketchMode)
  const axes = useConstruct((s) => s.axes)
  const points = useConstruct((s) => s.points)
  const planes = usePlanes((s) => s.data)
  const markers = useMarkers()
  const [hot, setHot] = useState<string | null>(null)
  const live = (type: string) => features.filter((f, i) => f.type === type && i < rollback && !f.suppressed && !hidden[f.id])
  const axisList = useMemo(() => [...live('constructAxis').map((f) => f.id), 'preview'].filter((id) => axes[id]).map((id) => ({ id, a: axes[id] })), [features, rollback, hidden, axes]) // eslint-disable-line react-hooks/exhaustive-deps
  const pointList = useMemo(() => [...live('constructPoint').map((f) => f.id), 'preview'].filter((id) => points[id]).map((id) => ({ id, p: points[id] })), [features, rollback, hidden, points]) // eslint-disable-line react-hooks/exhaustive-deps
  const isSel = (kind: string, id: string, index?: number) => selection.some((s) => s.kind === kind && s.id === id && s.index === index)
  const select = (kind: 'axis' | 'point' | 'plane' | 'vertex', id: string, index?: number) => useUi.getState().setSelection([{ kind, id, index }], false)
  const pickKind = (k: string) => (pick as string[]).includes(k)
  const L = half * 1.15

  if (sketching) return null
  const axisLine = (a: { origin: Vec3; dir: Vec3 }): [Vec3, Vec3] => [[a.origin[0] - a.dir[0] * L, a.origin[1] - a.dir[1] * L, a.origin[2] - a.dir[2] * L], [a.origin[0] + a.dir[0] * L, a.origin[1] + a.dir[1] * L, a.origin[2] + a.dir[2] * L]]
  const originAxes = [{ id: 'axisX', a: { origin: [0, 0, 0] as Vec3, dir: [1, 0, 0] as Vec3 } }, { id: 'axisY', a: { origin: [0, 0, 0] as Vec3, dir: [0, 1, 0] as Vec3 } }, { id: 'axisZ', a: { origin: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 } }]
  const originPlanes = (['XY', 'XZ', 'YZ'] as const).map((n) => ({ id: 'plane' + n, plane: originPlane(n) }))
  const planeFeatures = features.filter((f, i) => PLANE_FEATURES.has(f.type) && i < rollback && !f.suppressed && planes[f.id]).map((f) => ({ id: f.id, plane: planes[f.id] }))

  return (
    <group name="construct-layer">
      {axisList.map(({ id, a }) => (
        <group key={id}>
          <Line points={axisLine(a)} color={isSel('axis', id) ? selWhite : colors.accent} lineWidth={id === 'preview' ? 2.5 : 1.6} dashed dashSize={half * 0.03} gapSize={half * 0.015} raycast={noRay} />
        </group>
      ))}
      {pointList.map(({ id, p }) => (
        <Dot key={id} at={p} r={r} color={isSel('point', id) ? selWhite : colors.accent} hot={hot === 'pt' + id}
          onClick={pickKind('point') ? () => select('point', id) : undefined} onHover={pickKind('point') ? (on) => setHot(on ? 'pt' + id : null) : undefined} />
      ))}
      <CosmeticThreads r={r} />

      {/* click targets for reference fields */}
      {pickKind('axis') && [...originAxes, ...axisList].map(({ id, a }) => {
        const [p0, p1] = axisLine(a)
        const mid: Vec3 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2]
        const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...a.dir).normalize())
        return (
          <mesh key={'pa' + id} position={a.origin.length ? mid : mid} quaternion={q} renderOrder={30}
            onClick={(e) => { e.stopPropagation(); select('axis', id) }} onPointerOver={(e) => { e.stopPropagation(); setHot('ax' + id) }} onPointerOut={() => setHot(null)}>
            <cylinderGeometry args={[r * 0.9, r * 0.9, L * 2, 8]} />
            <meshBasicMaterial color={hot === 'ax' + id ? colors.sel : colors.accent} transparent opacity={hot === 'ax' + id ? 0.55 : 0.12} depthTest={false} />
          </mesh>
        )
      })}
      {pickKind('plane') && [...originPlanes, ...planeFeatures].map(({ id, plane }) => (
        <mesh key={'pp' + id} position={plane.origin} quaternion={planeQuaternion(plane)} renderOrder={5}
          onClick={(e) => { e.stopPropagation(); select('plane', id) }} onPointerMove={(e) => { e.stopPropagation(); if (hot !== 'pl' + id) setHot('pl' + id) }} onPointerOut={() => setHot(null)}>
          <planeGeometry args={[half * 2, half * 2]} />
          <meshBasicMaterial color={isSel('plane', id) || hot === 'pl' + id ? colors.sel : colors.accent} transparent opacity={isSel('plane', id) ? 0.4 : hot === 'pl' + id ? 0.35 : 0.1} side={DoubleSide} depthWrite={false} />
        </mesh>
      ))}
      {pickKind('vertex') && geometry.flatMap((b) => {
        if (hidden[b.id] || !b.mesh.vertexPos) return []
        const vp = b.mesh.vertexPos
        return Array.from({ length: vp.length / 3 }, (_, i) => {
          const k = `v${b.id}.${i}`
          return <Dot key={k} at={[vp[i * 3], vp[i * 3 + 1], vp[i * 3 + 2]]} r={r * 0.8} color={isSel('vertex', b.id, i) ? selWhite : colors.accent} hot={hot === k}
            onClick={() => select('vertex', b.id, i)} onHover={(on) => setHot(on ? k : null)} />
        })
      })}

      {markers.items.map((m) => (
        <Dot key={m.id} at={m.pos} r={r * (m.state === 'fixed' ? 0.8 : 1.1)} color={m.state === 'fixed' ? '#8a8f98' : m.state === 'off' ? '#d9625a' : '#e8b84a'} hollow={m.state === 'off'} hot={hot === 'mk' + m.id}
          onClick={m.state === 'fixed' || !markers.onClick ? undefined : () => markers.onClick?.(m.id)}
          onHover={m.state === 'fixed' ? undefined : (on) => setHot(on ? 'mk' + m.id : null)} />
      ))}
    </group>
  )
}
