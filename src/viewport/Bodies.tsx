import { useEffect, useMemo } from 'react'
import { Line } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import {
  BufferAttribute, BufferGeometry, DoubleSide, LineSegments, Material, Matrix4, MeshBasicMaterial, MeshStandardMaterial, Vector3, type Plane,
} from 'three'
import { useUi, type SelectionRef } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { useMove } from '@/features/move'
import { useHairPaint } from '@/features/hair/paint'
import { composeTransform, type Body } from '@/kernel/types'
import { buildBvh } from './bvh'
import { usePreview } from './preview'
import { useLastPick } from './lastPick'
import { useVpColors } from './colors'
import { useSketch } from '@/sketch/store'
import { sectionPlane } from './section'
import { SectionCap } from './SectionCap'
import { useSceneHalfSize } from './Origin'

/** Passed explicitly in both states: R3F does not restore the prototype raycast when a prop goes back to undefined. */
const noRaycast = () => null

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

/** Cap tints, one per body (cycled), so overlapping bodies stay distinguishable in a section. */
const CAP_COLORS = ['#5aa9c4', '#c4905a', '#7fb36a', '#b27fc4', '#c4c05a']

interface Mats { base: Material; hi: Material; dim: Material }

/** Renders the document's bodies (kernel output) with hover pre-highlight and filter-aware picking. */
export function Bodies() {
  const geometry = useDoc((s) => s.geometry)
  const colors = useVpColors()
  const displayMode = useUi((s) => s.displayMode)
  const hiddenUi = useUi((s) => s.hiddenIds)
  const previewHidden = usePreview((s) => s.hidden)
  const previewDim = usePreview((s) => s.dim)
  const hidden = useMemo(() => (previewHidden.length ? { ...hiddenUi, ...Object.fromEntries(previewHidden.map((i) => [i, true as const])) } : hiddenUi), [hiddenUi, previewHidden])
  const setStats = useUi((s) => s.setStats)
  const section = useUi((s) => s.section)
  const clip = useMemo(() => (section.on ? [sectionPlane(section)] : []), [section])

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
      clippingPlanes: clip,
    })
    const hi = new MeshBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: DoubleSide, clippingPlanes: clip })
    const dim = new MeshStandardMaterial({ color: colors.body, roughness: 0.62, metalness: 0.05, side: DoubleSide, transparent: true, opacity: 0.28, depthWrite: false, clippingPlanes: clip })
    return { base, hi, dim }
  }, [displayMode, colors, clip])

  return (
    <group name="bodies">
      {geometry.map((b, i) => (hidden[b.id] ? null : <BodyView key={b.key} body={b} mats={mats} colors={colors} index={i} clip={clip[0]} dimmed={previewDim.includes(b.id)} />))}
    </group>
  )
}

function BodyView({ body, mats, colors, index, clip, dimmed }: { body: Body; mats: Mats; colors: ReturnType<typeof useVpColors>; index: number; clip?: Plane; dimmed?: boolean }) {
  const capSize = useSceneHalfSize() * 2
  const geo = useMemo(() => buildGeometry(body), [body])
  useEffect(() => () => geo.dispose(), [geo])
  const displayMode = useUi((s) => s.displayMode)
  const filter = useUi((s) => s.selectionFilter)
  const hover = useUi((s) => s.hover)
  const selection = useUi((s) => s.selection)
  const setHover = useUi((s) => s.setHover)
  const setSelection = useUi((s) => s.setSelection)
  const move = useMove()

  // while sketching, body faces / edges are only pickable for the Project tool
  const sketchMode = useUi((s) => s.sketchMode)
  const projecting = useSketch((s) => s.active && s.tool === 'project')
  const sketching = sketchMode && !projecting
  const painting = useHairPaint((s) => s.mode !== 'off')
  const pickFaces = filter !== 'edge' && !sketching && !painting
  const showEdges = displayMode !== 'shaded' || filter === 'edge'
  const refFor = (e: ThreeEvent<PointerEvent | MouseEvent>): SelectionRef =>
    filter === 'body' ? { kind: 'body', id: body.id } : { kind: 'face', id: body.id, index: body.mesh.faceIds[e.faceIndex ?? 0] ?? 0 }

  const highlight = useUi((s) => s.highlight)
  const active = [...selection, ...highlight, ...(hover ? [hover] : [])].filter((r) => r.id === body.id)
  const wholeBody = active.some((r) => r.kind === 'body')
  const faceSet = useMemo(() => new Set(active.filter((r) => r.kind === 'face').map((r) => r.index!)), [selection, highlight, hover]) // eslint-disable-line react-hooks/exhaustive-deps
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
        material={dimmed ? mats.dim : mats.base}
        onPointerMove={pickFaces ? (e) => { e.stopPropagation(); const r = refFor(e); if (!sameRef(useUi.getState().hover, r)) setHover(r) } : undefined}
        onPointerOut={() => setHover(null)}
        onClick={pickFaces ? (e) => { e.stopPropagation(); const r = refFor(e); useLastPick.setState((s) => ({ point: [e.point.x, e.point.y, e.point.z], ref: r, seq: s.seq + 1 })); setSelection([r], e.shiftKey || e.ctrlKey) } : undefined}
      />
      {clip && <SectionCap geometry={geo} plane={clip} color={CAP_COLORS[index % CAP_COLORS.length]} order={20 + index * 4} size={capSize} />}
      {wholeBody && <mesh geometry={geo} material={mats.hi} raycast={() => null} renderOrder={2} />}
      {overlayGeo && <mesh geometry={overlayGeo} material={mats.hi} raycast={() => null} renderOrder={2} />}
      {showEdges && <EdgeLines body={body} color={colors.edge} accent={colors.accent} pickable={filter === 'edge' && !sketching} clip={mats.base.clippingPlanes ?? []} />}
    </group>
  )
}

function EdgeLines({ body, color, accent, pickable, clip }: { body: Body; color: string; accent: string; pickable: boolean; clip: Plane[] }) {
  const geo = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(body.mesh.edges, 3))
    return g
  }, [body])
  useEffect(() => () => geo.dispose(), [geo])
  const hover = useUi((s) => s.hover)
  const selection = useUi((s) => s.selection)
  const highlight = useUi((s) => s.highlight)
  const setHover = useUi((s) => s.setHover)
  const setSelection = useUi((s) => s.setSelection)
  const ids = body.mesh.edgeIds
  const edgeOf = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    const seg = Math.floor((e.index ?? 0) / 2)
    return ids ? ids[seg] : seg
  }
  const lit = useMemo(() => {
    const set = new Set([...selection, ...highlight, ...(hover ? [hover] : [])].filter((r) => r.kind === 'edge' && r.id === body.id).map((r) => r.index!))
    const out: Vector3[][] = []
    if (!set.size) return out
    const p = body.mesh.edges
    for (let s = 0; s < p.length / 6; s++) {
      if (set.has(ids ? ids[s] : s)) out.push([new Vector3(p[s * 6], p[s * 6 + 1], p[s * 6 + 2]), new Vector3(p[s * 6 + 3], p[s * 6 + 4], p[s * 6 + 5])])
    }
    return out
  }, [selection, highlight, hover, body, ids])
  return (
    <group>
      <lineSegments
        geometry={geo}
        raycast={pickable ? LineSegments.prototype.raycast : noRaycast}
        onPointerMove={pickable ? (e) => { e.stopPropagation(); setHover({ kind: 'edge', id: body.id, index: edgeOf(e) }) } : undefined}
        onPointerOut={() => setHover(null)}
        onClick={pickable ? (e) => { e.stopPropagation(); setSelection([{ kind: 'edge', id: body.id, index: edgeOf(e) }], e.shiftKey || e.ctrlKey) } : undefined}
      >
        <lineBasicMaterial color={color} clippingPlanes={clip} />
      </lineSegments>
      {lit.map((pts, i) => (
        <Line key={i} points={pts} color={accent} lineWidth={2.5} raycast={() => null} />
      ))}
    </group>
  )
}
