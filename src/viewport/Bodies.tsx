import { useEffect, useMemo } from 'react'
import { Line } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import {
  BoxGeometry, BufferGeometry, CylinderGeometry, DoubleSide, EdgesGeometry, Material, MeshBasicMaterial,
  MeshStandardMaterial, type Mesh, Vector3,
} from 'three'
import { useUi, type SelectionRef } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { buildBvh } from './bvh'
import { useVpColors } from './colors'

interface SampleBody {
  id: string
  geometry: BufferGeometry
  position: [number, number, number]
}

/** Demo geometry. The real document engine replaces this with kernel output (see store/ui selection refs). */
function makeSamples(): SampleBody[] {
  const box = buildBvh(new BoxGeometry(60, 40, 30))
  const boss = buildBvh(new CylinderGeometry(10, 10, 14, 48).rotateX(Math.PI / 2))
  return [
    { id: 'body1', geometry: box, position: [0, 0, 15] },
    { id: 'body2', geometry: boss, position: [10, 0, 37] },
  ]
}

const triCount = (g: BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3

/** Face id = index of the geometry group containing the triangle. */
function faceOf(g: BufferGeometry, faceIndex: number) {
  const v = faceIndex * 3
  const i = g.groups.findIndex((gr) => v >= gr.start && v < gr.start + gr.count)
  return i < 0 ? 0 : i
}

function sameRef(a: SelectionRef | null, b: SelectionRef) {
  return !!a && a.kind === b.kind && a.id === b.id && a.index === b.index
}

/** Renders the body list with hover pre-highlight and filter-aware picking (three-mesh-bvh accelerated). */
export function Bodies() {
  const samples = useMemo(makeSamples, [])
  const colors = useVpColors()
  const displayMode = useUi((s) => s.displayMode)
  const filter = useUi((s) => s.selectionFilter)
  const hover = useUi((s) => s.hover)
  const selection = useUi((s) => s.selection)
  const hidden = useUi((s) => s.hiddenIds)
  const setHover = useUi((s) => s.setHover)
  const setSelection = useUi((s) => s.setSelection)
  const setStats = useUi((s) => s.setStats)

  useEffect(() => {
    useDoc.setState({ bodies: samples.map((b, i) => ({ id: b.id, name: i === 0 ? 'Body1' : 'Boss' })) })
  }, [samples])
  useEffect(() => {
    setStats({ triangles: samples.filter((b) => !hidden[b.id]).reduce((n, b) => n + triCount(b.geometry), 0) })
  }, [samples, hidden, setStats])

  const mats = useMemo(() => {
    const mode = displayMode
    const base = new MeshStandardMaterial({
      color: colors.body, roughness: 0.62, metalness: 0.05, flatShading: false, side: DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      transparent: mode === 'xray', opacity: mode === 'xray' ? 0.32 : 1, depthWrite: mode !== 'xray',
      wireframe: mode === 'wireframe',
    })
    const hi = new MeshBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: DoubleSide })
    const off = new MeshBasicMaterial({ visible: false })
    return { base, hi, off }
  }, [displayMode, colors])

  const showEdges = displayMode !== 'shaded' || filter === 'edge'
  const pickFaces = filter !== 'edge'

  const refFor = (id: string, e: ThreeEvent<PointerEvent | MouseEvent>, g: BufferGeometry): SelectionRef =>
    filter === 'body' ? { kind: 'body', id } : { kind: 'face', id, index: faceOf(g, e.faceIndex ?? 0) }

  return (
    <group name="bodies">
      {samples.map((b) => {
        if (hidden[b.id]) return null
        const groupCount = b.geometry.groups.length
        const active = [...selection, ...(hover ? [hover] : [])].filter((r) => r.id === b.id)
        const wholeBody = active.some((r) => r.kind === 'body')
        const faceSet = new Set(active.filter((r) => r.kind === 'face').map((r) => r.index))
        const overlay: Material[] = Array.from({ length: groupCount }, (_, i) => (wholeBody || faceSet.has(i) ? mats.hi : mats.off))
        return (
          <group key={b.id} position={b.position}>
            <mesh
              geometry={b.geometry}
              material={mats.base}
              onPointerMove={pickFaces ? (e) => { e.stopPropagation(); const r = refFor(b.id, e, b.geometry); if (!sameRef(useUi.getState().hover, r)) setHover(r) } : undefined}
              onPointerOut={() => setHover(null)}
              onClick={pickFaces ? (e) => { e.stopPropagation(); setSelection([refFor(b.id, e, b.geometry)], e.shiftKey || e.ctrlKey) } : undefined}
            />
            {(wholeBody || faceSet.size > 0) && <mesh geometry={b.geometry} material={overlay} raycast={() => null} renderOrder={2} />}
            {showEdges && <EdgeLines id={b.id} geo={b.geometry} color={colors.edge} accent={colors.accent} pickable={filter === 'edge'} />}
          </group>
        )
      })}
    </group>
  )
}

function EdgeLines({ id, geo, color, accent, pickable }: { id: string; geo: BufferGeometry; color: string; accent: string; pickable: boolean }) {
  const edges = useMemo(() => new EdgesGeometry(geo, 30), [geo])
  const hover = useUi((s) => s.hover)
  const selection = useUi((s) => s.selection)
  const setHover = useUi((s) => s.setHover)
  const setSelection = useUi((s) => s.setSelection)
  const pos = edges.attributes.position
  const idxOf = (e: ThreeEvent<PointerEvent | MouseEvent>) => Math.floor((e.index ?? 0) / 2)
  const lit = [...selection, ...(hover ? [hover] : [])].filter((r) => r.kind === 'edge' && r.id === id)
  return (
    <group>
      <lineSegments
        geometry={edges}
        raycast={pickable ? undefined : () => null}
        onPointerMove={pickable ? (e) => { e.stopPropagation(); setHover({ kind: 'edge', id, index: idxOf(e) }) } : undefined}
        onPointerOut={() => setHover(null)}
        onClick={pickable ? (e) => { e.stopPropagation(); setSelection([{ kind: 'edge', id, index: idxOf(e) }], e.shiftKey || e.ctrlKey) } : undefined}
      >
        <lineBasicMaterial color={color} />
      </lineSegments>
      {lit.map((r) => (
        <Line
          key={r.index}
          points={[new Vector3().fromBufferAttribute(pos, r.index! * 2), new Vector3().fromBufferAttribute(pos, r.index! * 2 + 1)]}
          color={accent}
          lineWidth={2.5}
          raycast={() => null}
        />
      ))}
    </group>
  )
}

export type { Mesh }
