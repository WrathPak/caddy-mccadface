import { useEffect, useMemo } from 'react'
import { Line } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import {
  BufferAttribute, BufferGeometry, DoubleSide, Material, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Vector3,
} from 'three'
import { useUi, type SelectionRef } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { useMove } from '@/features/move'
import { composeTransform, type Body } from '@/kernel/types'
import { buildBvh } from './bvh'
import { useVpColors } from './colors'

function sameRef(a: SelectionRef | null, b: SelectionRef) {
  return !!a && a.kind === b.kind && a.id === b.id && a.index === b.index
}

function buildGeometry(b: Body): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(b.mesh.positions, 3))
  g.setAttribute('normal', new BufferAttribute(b.mesh.normals, 3))
  g.setIndex(new BufferAttribute(b.mesh.indices, 1))
  return buildBvh(g)
}

/** Sub-geometry (shared vertices) holding only the triangles of the given faces. */
function faceSubset(b: Body, geo: BufferGeometry, faces: Set<number>): BufferGeometry {
  const idx: number[] = []
  const src = b.mesh.indices, ids = b.mesh.faceIds
  for (let t = 0; t < ids.length; t++) if (faces.has(ids[t])) idx.push(src[t * 3], src[t * 3 + 1], src[t * 3 + 2])
  const g = new BufferGeometry()
  g.setAttribute('position', geo.getAttribute('position'))
  g.setIndex(idx)
  return g
}

interface Mats { base: Material; hi: Material }

/** Renders the document's bodies (kernel output) with hover pre-highlight and filter-aware picking. */
export function Bodies() {
  const geometry = useDoc((s) => s.geometry)
  const colors = useVpColors()
  const displayMode = useUi((s) => s.displayMode)
  const hidden = useUi((s) => s.hiddenIds)
  const setStats = useUi((s) => s.setStats)

  useEffect(() => {
    const tris = geometry.filter((b) => !hidden[b.id]).reduce((n, b) => n + b.mesh.indices.length / 3, 0)
    setStats({ triangles: tris })
  }, [geometry, hidden, setStats])

  const mats = useMemo<Mats>(() => {
    const base = new MeshStandardMaterial({
      color: colors.body, roughness: 0.62, metalness: 0.05, side: DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      transparent: displayMode === 'xray', opacity: displayMode === 'xray' ? 0.32 : 1, depthWrite: displayMode !== 'xray',
      wireframe: displayMode === 'wireframe',
    })
    const hi = new MeshBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: DoubleSide })
    return { base, hi }
  }, [displayMode, colors])

  return (
    <group name="bodies">
      {geometry.map((b) => (hidden[b.id] ? null : <BodyView key={b.key} body={b} mats={mats} colors={colors} />))}
    </group>
  )
}

function BodyView({ body, mats, colors }: { body: Body; mats: Mats; colors: ReturnType<typeof useVpColors> }) {
  const geo = useMemo(() => buildGeometry(body), [body])
  useEffect(() => () => geo.dispose(), [geo])
  const displayMode = useUi((s) => s.displayMode)
  const filter = useUi((s) => s.selectionFilter)
  const hover = useUi((s) => s.hover)
  const selection = useUi((s) => s.selection)
  const setHover = useUi((s) => s.setHover)
  const setSelection = useUi((s) => s.setSelection)
  const move = useMove()

  const pickFaces = filter !== 'edge'
  const showEdges = displayMode !== 'shaded' || filter === 'edge'
  const refFor = (e: ThreeEvent<PointerEvent | MouseEvent>): SelectionRef =>
    filter === 'body' ? { kind: 'body', id: body.id } : { kind: 'face', id: body.id, index: body.mesh.faceIds[e.faceIndex ?? 0] ?? 0 }

  const active = [...selection, ...(hover ? [hover] : [])].filter((r) => r.id === body.id)
  const wholeBody = active.some((r) => r.kind === 'body')
  const faceSet = useMemo(() => new Set(active.filter((r) => r.kind === 'face').map((r) => r.index!)), [selection, hover]) // eslint-disable-line react-hooks/exhaustive-deps
  const overlayGeo = useMemo(() => (!wholeBody && faceSet.size ? faceSubset(body, geo, faceSet) : null), [wholeBody, faceSet, body, geo])
  useEffect(() => () => overlayGeo?.dispose(), [overlayGeo])

  const matrix = useMemo(() => {
    if (!move.active || !move.bodyIds.includes(body.id)) return null
    return new Matrix4().fromArray(composeTransform({ pivot: move.pivot, translate: move.translate, rotate: move.rotate, scale: move.scale }))
  }, [move.active, move.bodyIds, move.pivot, move.translate, move.rotate, move.scale, body.id])

  return (
    <group matrixAutoUpdate={matrix === null} matrix={matrix ?? undefined}>
      <mesh
        geometry={geo}
        material={mats.base}
        onPointerMove={pickFaces ? (e) => { e.stopPropagation(); const r = refFor(e); if (!sameRef(useUi.getState().hover, r)) setHover(r) } : undefined}
        onPointerOut={() => setHover(null)}
        onClick={pickFaces ? (e) => { e.stopPropagation(); setSelection([refFor(e)], e.shiftKey || e.ctrlKey) } : undefined}
      />
      {wholeBody && <mesh geometry={geo} material={mats.hi} raycast={() => null} renderOrder={2} />}
      {overlayGeo && <mesh geometry={overlayGeo} material={mats.hi} raycast={() => null} renderOrder={2} />}
      {showEdges && <EdgeLines body={body} color={colors.edge} accent={colors.accent} pickable={filter === 'edge'} />}
    </group>
  )
}

function EdgeLines({ body, color, accent, pickable }: { body: Body; color: string; accent: string; pickable: boolean }) {
  const geo = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(body.mesh.edges, 3))
    return g
  }, [body])
  useEffect(() => () => geo.dispose(), [geo])
  const hover = useUi((s) => s.hover)
  const selection = useUi((s) => s.selection)
  const setHover = useUi((s) => s.setHover)
  const setSelection = useUi((s) => s.setSelection)
  const ids = body.mesh.edgeIds
  const edgeOf = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    const seg = Math.floor((e.index ?? 0) / 2)
    return ids ? ids[seg] : seg
  }
  const lit = useMemo(() => {
    const set = new Set([...selection, ...(hover ? [hover] : [])].filter((r) => r.kind === 'edge' && r.id === body.id).map((r) => r.index!))
    const out: Vector3[][] = []
    if (!set.size) return out
    const p = body.mesh.edges
    for (let s = 0; s < p.length / 6; s++) {
      if (set.has(ids ? ids[s] : s)) out.push([new Vector3(p[s * 6], p[s * 6 + 1], p[s * 6 + 2]), new Vector3(p[s * 6 + 3], p[s * 6 + 4], p[s * 6 + 5])])
    }
    return out
  }, [selection, hover, body, ids])
  return (
    <group>
      <lineSegments
        geometry={geo}
        raycast={pickable ? undefined : () => null}
        onPointerMove={pickable ? (e) => { e.stopPropagation(); setHover({ kind: 'edge', id: body.id, index: edgeOf(e) }) } : undefined}
        onPointerOut={() => setHover(null)}
        onClick={pickable ? (e) => { e.stopPropagation(); setSelection([{ kind: 'edge', id: body.id, index: edgeOf(e) }], e.shiftKey || e.ctrlKey) } : undefined}
      >
        <lineBasicMaterial color={color} />
      </lineSegments>
      {lit.map((pts, i) => (
        <Line key={i} points={pts} color={accent} lineWidth={2.5} raycast={() => null} />
      ))}
    </group>
  )
}
