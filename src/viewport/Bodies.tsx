import { useEffect, useMemo, useRef, useState } from 'react'
import { Line } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import {
  Box3, BufferAttribute, BufferGeometry, DoubleSide, LineSegments, Material, Matrix4, Mesh, MeshBasicMaterial, Object3D, MeshStandardMaterial, Sphere, Vector3, type Plane,
} from 'three'
import { useUi, type SelectionRef } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { useMove } from '@/features/move'
import { useHairPaint } from '@/features/hair/paint'
import { composeTransform, type Body } from '@/kernel/types'
import { attachBvh, buildBvh } from './bvh'
import { registerLodSwap, useMotion, useWarm } from './motion'
import { usePreview } from './preview'
import { useLastPick } from './lastPick'
import { useVpColors } from './colors'
import { useSketch } from '@/sketch/store'
import { sectionPlane } from './section'
import { SectionCap } from './SectionCap'
import { useSceneHalfSize } from './Origin'
import { instanceDimmed, instanceHidden, instancePickable, useInstances } from '@/assembly/place'
import { within, type Instance } from '@/assembly/instances'
import { isIdentity, invert, point } from '@/assembly/matrix'
import { useAssemblyRuntime } from '@/assembly/runtime'
import { nearestSnaps } from '@/assembly/snapPick'
import { beginDrag } from '@/assembly/dragController'
import { snapPoints, snapSpec } from '@/assembly/snaps'

/** Passed explicitly in both states: R3F does not restore the prototype raycast when a prop goes back to undefined. */
const noRaycast = () => null

function sameRef(a: SelectionRef | null, b: SelectionRef) {
  return !!a && a.kind === b.kind && a.id === b.id && a.index === b.index && (a.path ?? '') === (b.path ?? '')
}

function buildGeometry(b: Body): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(b.mesh.positions, 3))
  g.setAttribute('normal', new BufferAttribute(b.mesh.normals, 3))
  g.setIndex(new BufferAttribute(b.mesh.indices, 1))
  applyKnownBounds(g, b.mesh.bounds)
  // bigger meshes arrive with a BVH a worker built; building one here would freeze the page
  return b.mesh.bvh ? attachBvh(g, b.mesh.bvh) : buildBvh(g)
}

/** Set the bounding box / sphere from numbers a worker computed, so three never has to scan millions of vertices for them. */
function applyKnownBounds(g: BufferGeometry, bounds: Body['mesh']['bounds']) {
  if (!bounds) return
  const box = new Box3(new Vector3(...bounds.min), new Vector3(...bounds.max))
  g.boundingBox = box
  g.boundingSphere = box.getBoundingSphere(new Sphere())
}

/** Triangles per piece of a big mesh's drawn geometry. */
const CHUNK_TRIS = 100_000
/** Never drawn: the mesh that only exists for picking. */
const HIDDEN = new MeshBasicMaterial({ visible: false })

/** Own, compact geometry for the triangles t0..t1 of a body's mesh. */
function buildChunk(b: Body, t0: number, t1: number): BufferGeometry {
  const m = b.mesh
  const remap = new Int32Array(m.positions.length / 3).fill(-1)
  const verts: number[] = []
  const idx = new Uint32Array((t1 - t0) * 3)
  for (let i = 0; i < idx.length; i++) {
    const v = m.indices[t0 * 3 + i]
    let r = remap[v]
    if (r < 0) { r = remap[v] = verts.length; verts.push(v) }
    idx[i] = r
  }
  const pos = new Float32Array(verts.length * 3), nrm = new Float32Array(verts.length * 3)
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i] * 3
    pos[i * 3] = m.positions[v]; pos[i * 3 + 1] = m.positions[v + 1]; pos[i * 3 + 2] = m.positions[v + 2]
    nrm[i * 3] = m.normals[v]; nrm[i * 3 + 1] = m.normals[v + 1]; nrm[i * 3 + 2] = m.normals[v + 2]
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('normal', new BufferAttribute(nrm, 3))
  g.setIndex(new BufferAttribute(idx, 1))
  applyKnownBounds(g, b.mesh.bounds)
  return g
}

/** The decimated stand-in drawn while the camera moves (only bodies that came with one). */
function buildLodGeometry(b: Body): BufferGeometry | null {
  const l = b.mesh.lod
  if (!l) return null
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(l.positions, 3))
  g.setAttribute('normal', new BufferAttribute(l.normals, 3))
  g.setIndex(new BufferAttribute(l.indices, 1))
  applyKnownBounds(g, b.mesh.bounds)
  return g
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

interface Mats { base: Material; /** surface bodies (open shells): a tinted material, drawn from both sides */ surf: Material; hi: Material; dim: Material; flag: Material }

/** Renders the document's bodies (kernel output) with hover pre-highlight and filter-aware picking. One body is drawn once per instance of its component. */
export function Bodies() {
  const instances = useInstances()
  const colors = useVpColors()
  const displayMode = useUi((s) => s.displayMode)
  const hiddenUi = useUi((s) => s.hiddenIds)
  const previewHidden = usePreview((s) => s.hidden)
  const previewDim = usePreview((s) => s.dim)
  const hidden = useMemo(() => (previewHidden.length ? { ...hiddenUi, ...Object.fromEntries(previewHidden.map((i) => [i, true as const])) } : hiddenUi), [hiddenUi, previewHidden])
  const setStats = useUi((s) => s.setStats)
  const section = useUi((s) => s.section)
  const clip = useMemo(() => (section.on ? [sectionPlane(section)] : []), [section])
  const active = useDoc((s) => s.activeOcc)
  const assembly = useDoc((s) => s.assembly)
  const overlap = useAssemblyRuntime((s) => s.interference)
  const flagged = useMemo(() => new Set((overlap?.hits ?? []).flatMap((h) => [`${h.a.occ}|${h.a.body}`, `${h.b.occ}|${h.b.body}`])), [overlap])

  useEffect(() => {
    const tris = instances.filter((i) => !instanceHidden(i, hidden)).reduce((n, i) => n + i.body.mesh.indices.length / 3, 0)
    setStats({ triangles: tris })
  }, [instances, hidden, setStats])

  const mats = useMemo<Mats>(() => {
    const base = new MeshStandardMaterial({
      color: colors.body, roughness: 0.62, metalness: 0.05, side: DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      transparent: displayMode === 'xray', opacity: displayMode === 'xray' ? 0.32 : 1, depthWrite: displayMode !== 'xray',
      wireframe: displayMode === 'wireframe',
      clippingPlanes: clip,
    })
    const surf = new MeshStandardMaterial({
      color: colors.surface, roughness: 0.5, metalness: 0.05, side: DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      transparent: displayMode === 'xray', opacity: displayMode === 'xray' ? 0.32 : 1, depthWrite: displayMode !== 'xray',
      wireframe: displayMode === 'wireframe',
      clippingPlanes: clip,
    })
    const hi = new MeshBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: DoubleSide, clippingPlanes: clip })
    const dim = new MeshStandardMaterial({ color: colors.body, roughness: 0.62, metalness: 0.05, side: DoubleSide, transparent: true, opacity: 0.28, depthWrite: false, clippingPlanes: clip })
    const flag = new MeshStandardMaterial({ color: '#d9625a', roughness: 0.55, metalness: 0.05, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: clip, wireframe: displayMode === 'wireframe' })
    return { base, surf, hi, dim, flag }
  }, [displayMode, colors, clip])

  const warm = useWarm((s) => s.on)
  return (
    <>
      {warm && instances.length === 0 && <ShaderWarmup material={mats.base} />}
      <group name="bodies">
        {instances.map((i, n) => (instanceHidden(i, hidden) ? null : (
          <BodyView
            key={i.key + '|' + i.body.key} inst={i} mats={mats} colors={colors} index={n} clip={clip[0]}
            dimmed={previewDim.includes(i.body.id) || instanceDimmed(i, active)}
            flagged={flagged.has(i.key)}
            pickable={instancePickable(i, { activeOcc: active, assembly })}
          />
        )))}
      </group>
      
    </>
  )
}

/**
 * A speck of geometry drawn with the body material while the scene is empty, so the shader programs (and the AO passes that
 * draw the scene again) are compiled before the first body appears. Software GL takes over a hundred milliseconds to link
 * them, which would otherwise land in the frame that first shows a big import.
 */
function ShaderWarmup({ material }: { material: Material }) {
  const geo = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1e-4, 0, 0, 0, 1e-4, 0]), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3))
    return g
  }, [])
  useEffect(() => () => geo.dispose(), [geo])
  return (
    <>
      <mesh name="warmup" geometry={geo} material={material} frustumCulled={false} raycast={noRaycast} />
      <lineSegments geometry={geo} frustumCulled={false} raycast={noRaycast}><lineBasicMaterial color="#000" /></lineSegments>
    </>
  )
}

function BodyView({ inst, mats, colors, index, clip, dimmed, flagged, pickable }: { inst: Instance; mats: Mats; colors: ReturnType<typeof useVpColors>; index: number; clip?: Plane; dimmed?: boolean; flagged?: boolean; pickable: boolean }) {
  const body = inst.body
  const capSize = useSceneHalfSize() * 2
  const lodGeo = useMemo(() => buildLodGeometry(body), [body])
  useEffect(() => () => lodGeo?.dispose(), [lodGeo])
  const geo = useMemo(() => buildGeometry(body), [body])
  useEffect(() => () => geo.dispose(), [geo])
  // a big mesh is drawn from pieces of about CHUNK_TRIS triangles, one made and sent to the GPU per frame, so no single frame
  // carries the whole upload; `geo` (never drawn then) still serves picking, the highlight and sections
  const chunked = body.mesh.indices.length / 3 > CHUNK_TRIS * 1.2
  const [chunks, setChunks] = useState<BufferGeometry[]>([])
  const [chunksDone, setChunksDone] = useState(!chunked)
  useEffect(() => {
    if (!chunked) return
    let t = 0, raf = 0
    const made: BufferGeometry[] = []
    const total = body.mesh.indices.length / 3
    const step = () => {
      const g = buildChunk(body, t, Math.min(total, t + CHUNK_TRIS))
      made.push(g)
      t += CHUNK_TRIS
      setChunks([...made])
      if (t < total) raf = requestAnimationFrame(step)
      else setChunksDone(true)
    }
    raf = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(raf); for (const g of made) g.dispose() }
  }, [chunked, body])
  const fullRef = useRef<Object3D>(null)
  const lodRef = useRef<Mesh>(null)
  const swap = useRef<ReturnType<typeof registerLodSwap> | null>(null)
  // the low-res mesh is swapped in by the render loop (see motion.tsx); React only learns about it for the highlight below
  useEffect(() => {
    if (!lodGeo || !fullRef.current || !lodRef.current) return
    swap.current = registerLodSwap(fullRef.current, lodRef.current, chunksDone)
    return () => { swap.current?.dispose(); swap.current = null }
  }, [lodGeo]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { swap.current?.setReady(chunksDone) }, [chunksDone])
  const showLod = useMotion((s) => s.moving) && !!lodGeo
  const displayMode = useUi((s) => s.displayMode)
  const filter = useUi((s) => s.selectionFilter)
  const hover = useUi((s) => s.hover)
  const selection = useUi((s) => s.selection)
  const setHover = useUi((s) => s.setHover)
  const setSelection = useUi((s) => s.setSelection)
  const move = useMove()
  const snapping = useUi((s) => s.pickKinds.includes('snap'))
  const dragging = useAssemblyRuntime((s) => s.tool === 'drag')

  // while sketching, body faces / edges are only pickable for the Project tool
  const sketchMode = useUi((s) => s.sketchMode)
  const projecting = useSketch((s) => s.active && s.tool === 'project')
  const sketching = sketchMode && !projecting
  const painting = useHairPaint((s) => s.mode !== 'off')
  const byComponent = filter === 'component' && !!inst.occ
  const pickFaces = filter !== 'edge' && !sketching && !painting && !snapping && !dragging
  // an open surface always shows its edges: they are what tells a surface from a solid, and what the stitch and extend tools pick
  const showEdges = displayMode !== 'shaded' || filter === 'edge' || !!body.surface
  const bodyMat = flagged ? mats.flag : dimmed ? mats.dim : body.surface ? mats.surf : mats.base
  const path = inst.occ || undefined
  const refFor = (e: ThreeEvent<PointerEvent | MouseEvent>): SelectionRef =>
    byComponent ? { kind: 'component', id: inst.occ }
      : filter === 'body' || filter === 'component' ? { kind: 'body', id: body.id, path }
        : { kind: 'face', id: body.id, index: body.mesh.faceIds[e.faceIndex ?? 0] ?? 0, path }
  // feature tools work on the geometry as its component defines it: instances they cannot address do not take their picks
  const canPick = pickable || byComponent
  const meshRaycast = canPick || snapping || dragging ? Mesh.prototype.raycast : noRaycast

  const highlight = useUi((s) => s.highlight)
  const mine = (r: SelectionRef) => (r.kind === 'component' ? within(inst.path, r.id) : r.id === body.id && (r.path === undefined || r.path === inst.occ))
  // a very large mesh is a single face: tinting all of it on hover would draw millions of triangles again for no information
  const active = [...selection, ...highlight, ...(hover && !body.mesh.lod ? [hover] : [])].filter(mine)
  const faceSet = useMemo(() => new Set(active.filter((r) => r.kind === 'face').map((r) => r.index!)), [selection, highlight, hover]) // eslint-disable-line react-hooks/exhaustive-deps
  // every face picked is the whole body (a very large mesh is one face): tint the geometry as it is instead of copying millions of indices
  const wholeBody = active.some((r) => r.kind === 'body' || r.kind === 'component') || (faceSet.size > 0 && faceSet.size >= (body.mesh.faceCount ?? Infinity))
  const overlayGeo = useMemo(() => (!wholeBody && faceSet.size ? faceSubset(body, geo, faceSet) : null), [wholeBody, faceSet, body, geo])
  useEffect(() => () => overlayGeo?.dispose(), [overlayGeo])

  const matrix = useMemo(() => {
    const placed = !isIdentity(inst.world)
    const moving = move.active && move.bodyIds.includes(body.id)
    if (!placed && !moving) return null
    const m = new Matrix4().fromArray(inst.world)
    if (moving) m.multiply(new Matrix4().fromArray(composeTransform({ pivot: move.pivot, translate: move.translate, rotate: move.rotate, scale: move.scale })))
    return m
  }, [inst.world, move.active, move.bodyIds, move.pivot, move.translate, move.rotate, move.scale, body.id])

  const snapAt = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    const local = point(invert(inst.world), [e.point.x, e.point.y, e.point.z])
    return nearestSnaps(snapPoints(body), local)
  }

  return (
    <>
      <group matrixAutoUpdate={matrix === null} matrix={matrix ?? undefined}>
        {lodGeo && <mesh ref={lodRef} geometry={lodGeo} material={bodyMat} visible={false} raycast={noRaycast} />}
        {chunked && (
          // squashed to nothing until every piece is uploaded: still drawn (so the GPU gets it), nothing to see, and no extra shader
          <group ref={fullRef as never} scale={chunksDone ? 1 : 0}>
            {chunks.map((g, i) => <mesh key={i} geometry={g} material={bodyMat} frustumCulled={chunksDone} raycast={noRaycast} />)}
          </group>
        )}
        <mesh
          ref={chunked ? undefined : (fullRef as never)}
          geometry={geo}
          material={chunked ? HIDDEN : bodyMat}
          raycast={meshRaycast}
          onPointerDown={dragging ? (e) => { if (e.button === 0) { e.stopPropagation(); beginDrag(e, inst) } } : undefined}
          onPointerMove={
            snapping
              ? (e) => { e.stopPropagation(); const s = snapAt(e); useAssemblyRuntime.getState().setSnapHover(s ? { inst: inst.key, index: s.nearest, near: s.near } : null) }
              : pickFaces && canPick ? (e) => { e.stopPropagation(); const r = refFor(e); if (!sameRef(useUi.getState().hover, r)) setHover(r) } : undefined
          }
          onPointerOut={() => { setHover(null); if (snapping) useAssemblyRuntime.getState().setSnapHover(null) }}
          onClick={
            snapping
              ? (e) => {
                  e.stopPropagation()
                  const s = snapAt(e)
                  if (!s) return
                  const sp = snapPoints(body)[s.nearest]
                  setSelection([{ kind: 'snap', id: body.id, index: s.nearest, path, snap: snapSpec(body, sp, inst.occ || undefined) }])
                }
              : pickFaces && canPick ? (e) => { e.stopPropagation(); const r = refFor(e); useLastPick.setState((s) => ({ point: [e.point.x, e.point.y, e.point.z], ref: r, seq: s.seq + 1 })); setSelection([r], e.shiftKey || e.ctrlKey) } : undefined
          }
        />
        {wholeBody && <mesh geometry={showLod ? lodGeo! : geo} material={mats.hi} raycast={() => null} renderOrder={2} />}
        {overlayGeo && <mesh geometry={overlayGeo} material={mats.hi} raycast={() => null} renderOrder={2} />}
        {showEdges && <EdgeLines body={body} inst={inst} color={colors.edge} accent={colors.accent} pickable={filter === 'edge' && !sketching && pickable && !snapping && !dragging} clip={mats.base.clippingPlanes ?? []} />}
      </group>
      {clip && !body.surface && <SectionCap geometry={geo} plane={clip} color={CAP_COLORS[index % CAP_COLORS.length]} order={20 + index * 4} size={capSize} matrix={matrix ?? undefined} />}
    </>
  )
}

function EdgeLines({ body, inst, color, accent, pickable, clip }: { body: Body; inst: Instance; color: string; accent: string; pickable: boolean; clip: Plane[] }) {
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
  const path = inst.occ || undefined
  const edgeOf = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    const seg = Math.floor((e.index ?? 0) / 2)
    return ids ? ids[seg] : seg
  }
  const lit = useMemo(() => {
    const set = new Set([...selection, ...highlight, ...(hover ? [hover] : [])].filter((r) => r.kind === 'edge' && r.id === body.id && (r.path === undefined || r.path === inst.occ)).map((r) => r.index!))
    const out: Vector3[][] = []
    if (!set.size) return out
    const p = body.mesh.edges
    for (let s = 0; s < p.length / 6; s++) {
      if (set.has(ids ? ids[s] : s)) out.push([new Vector3(p[s * 6], p[s * 6 + 1], p[s * 6 + 2]), new Vector3(p[s * 6 + 3], p[s * 6 + 4], p[s * 6 + 5])])
    }
    return out
  }, [selection, highlight, hover, body, ids, inst.occ])
  return (
    <group>
      <lineSegments
        geometry={geo}
        raycast={pickable ? LineSegments.prototype.raycast : noRaycast}
        onPointerMove={pickable ? (e) => { e.stopPropagation(); setHover({ kind: 'edge', id: body.id, index: edgeOf(e), path }) } : undefined}
        onPointerOut={() => setHover(null)}
        onClick={pickable ? (e) => { e.stopPropagation(); setSelection([{ kind: 'edge', id: body.id, index: edgeOf(e), path }], e.shiftKey || e.ctrlKey) } : undefined}
      >
        <lineBasicMaterial color={color} clippingPlanes={clip} />
      </lineSegments>
      {lit.map((pts, i) => (
        <Line key={i} points={pts} color={accent} lineWidth={2.5} raycast={() => null} />
      ))}
    </group>
  )
}
