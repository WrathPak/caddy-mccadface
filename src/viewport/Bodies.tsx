import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Line } from '@react-three/drei'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import {
  Box3, BufferAttribute, BufferGeometry, DoubleSide, LineSegments, Material, Matrix4, Mesh, MeshBasicMaterial, MeshNormalMaterial, Object3D, MeshStandardMaterial, OrthographicCamera, Scene, Sphere, Vector3,
  WebGLRenderTarget, type Plane, type WebGLRenderer,
} from 'three'
import { useUi, type SelectionRef } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { useMove } from '@/features/move'
import { useHairPaint } from '@/features/hair/paint'
import { composeTransform, type Body, type MeshChunk } from '@/kernel/types'
import { attachBvh, buildBvh } from './bvh'
import { CHUNK_TRIS, CHUNKED_MIN_TRIS, chunker } from '@/kernel/bigmesh'
import { registerLodSwap, useMotion, useWarm } from './motion'
import { usePreview } from './preview'
import { useFaceEdges } from './faceEdges'
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

/** How long after the viewport starts the shader warm-up speck stays up. */
const BOOT_WARM_MS = 2500
/** How long one task sends pieces to the GPU before it gives the main thread back. */
const UPLOAD_SLICE_MS = 20
/** Never drawn: the mesh that only exists for picking. */
const HIDDEN = new MeshBasicMaterial({ visible: false })
const isBig = (b: Body) => b.mesh.indices.length / 3 > CHUNKED_MIN_TRIS

/** A piece of a big mesh as geometry. */
function chunkGeometry(c: MeshChunk, bounds: Body['mesh']['bounds']): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(c.positions, 3))
  g.setAttribute('normal', new BufferAttribute(c.normals, 3))
  g.setIndex(new BufferAttribute(c.indices, 1))
  applyKnownBounds(g, bounds)
  return g
}

/**
 * Sends geometries to the GPU without drawing a frame. three uploads a geometry the first time it is drawn, so each is drawn once
 * into a one pixel render target, with a material that reads the attributes the real one does (position, normal, index). A frame
 * of the whole scene is what an upload would otherwise ride on, and under a slow CPU a frame is long before it carries anything:
 * the page has to composite, lay out and paint the canvas, take the ambient occlusion passes, and so on.
 */
function makeUploader(gl: WebGLRenderer) {
  const target = new WebGLRenderTarget(1, 1)
  const material = new MeshNormalMaterial()
  const mesh = new Mesh(undefined, material)
  mesh.frustumCulled = false
  const scene = new Scene()
  scene.add(mesh)
  const camera = new OrthographicCamera(-1, 1, 1, -1, -1, 1)
  return {
    send(g: BufferGeometry) {
      mesh.geometry = g
      const prev = gl.getRenderTarget()
      gl.setRenderTarget(target)
      try { gl.render(scene, camera) } finally { gl.setRenderTarget(prev) }
    },
    dispose() { target.dispose(); material.dispose() },
  }
}

/** The decimated stand-in drawn while the camera moves (only bodies that came with one). */
function buildLodGeometry(b: Body): BufferGeometry | null {
  const l = b.mesh.lod
  if (!l) return null
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(l.positions, 3))
  g.setAttribute('normal', new BufferAttribute(l.normals, 3))
  // fewer than 65536 vertices: half the bytes to send, and the driver checks every index
  g.setIndex(new BufferAttribute(l.positions.length / 3 < 65536 ? new Uint16Array(l.indices) : l.indices, 1))
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
  const current = useInstances()
  // a big mesh arriving is a lot of scene to build: rendered at low priority React hands the main thread back every few
  // milliseconds in between, where a normal update would do all of it in one task. Small edits are not held back.
  const deferred = useDeferredValue(current)
  const instances = current.some((i) => isBig(i.body)) ? deferred : current
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
    const hi = new MeshBasicMaterial({ color: colors.sel, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, side: DoubleSide, clippingPlanes: clip })
    const dim = new MeshStandardMaterial({ color: colors.body, roughness: 0.62, metalness: 0.05, side: DoubleSide, transparent: true, opacity: 0.28, depthWrite: false, clippingPlanes: clip })
    const flag = new MeshStandardMaterial({ color: '#d9625a', roughness: 0.55, metalness: 0.05, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: clip, wireframe: displayMode === 'wireframe' })
    return { base, surf, hi, dim, flag }
  }, [displayMode, colors, clip])

  // the shaders are linked (and the environment lighting uploaded) once the app has settled, in a task nobody is waiting on:
  // linking them in the frame that first draws a body costs a long task, and software GL takes the better part of a second
  const warm = useWarm((s) => s.on)
  const [boot, setBoot] = useState(true)
  useEffect(() => {
    const t = window.setTimeout(() => setBoot(false), BOOT_WARM_MS)
    return () => clearTimeout(t)
  }, [])
  return (
    <>
      {(warm || boot) && instances.length === 0 && <ShaderWarmup material={mats.base} />}
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
  // a big mesh is drawn from pieces of about CHUNK_TRIS triangles, sent to the GPU a few at a time in tasks of their own (see
  // makeUploader), so no single task carries the whole upload; `geo` (never drawn then) still serves picking, the highlight and sections
  const chunked = isBig(body)
  const invalidate = useThree((s) => s.invalidate)
  const gl = useThree((s) => s.gl)
  const [chunksDone, setChunksDone] = useState(!chunked)
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
  // Fillet / Chamfer in the Edge filter: a face stands for its edges
  const onFaceEdges = useFaceEdges((s) => s.onFace)
  const faceEdges = filter === 'edge' && !!onFaceEdges && !sketching && !painting && !snapping && !dragging
  // an open surface always shows its edges: they are what tells a surface from a solid, and what the stitch and extend tools pick
  const showEdges = displayMode !== 'shaded' || filter === 'edge' || !!body.surface
  const bodyMat = flagged ? mats.flag : dimmed ? mats.dim : body.surface ? mats.surf : mats.base
  // the pieces go straight into their group instead of through React state: re-rendering the body for every one of the
  // dozens of pieces (each re-diffing all the earlier ones) cost more main-thread time than building and uploading it
  const matRef = useRef(bodyMat)
  useEffect(() => {
    matRef.current = bodyMat
    for (const m of (fullRef.current as Object3D | null)?.children ?? []) (m as Mesh).material = bodyMat
  }, [bodyMat])
  useEffect(() => {
    const group = fullRef.current
    if (!chunked || !group) return
    let t = 0, timer = 0
    const total = body.mesh.indices.length / 3
    // the worker that made the mesh cut the pieces; a body made elsewhere (a B-rep, a mesh boolean) is cut here
    const ready = body.mesh.chunks
    const cut = ready ? null : chunker(body.mesh.positions, body.mesh.normals, body.mesh.indices)
    const uploader = makeUploader(gl)
    const pieces: BufferGeometry[] = []
    const made: Mesh[] = []
    // Each task sends pieces to the GPU until it has used up its share of the main thread, then hands the thread back, so no
    // task is long and the page keeps answering in between. Nothing is in the scene until the last piece is up: the pieces
    // are drawn for the first time as one body, with nothing left to send.
    const step = () => {
      const t0 = performance.now()
      if (lodGeo && pieces.length === 0) uploader.send(lodGeo) // the low-res copy stands in for the body, and has to be up first
      do {
        const piece = ready ? ready[pieces.length] : cut!(t, Math.min(total, t + CHUNK_TRIS))
        const g = chunkGeometry(piece, body.mesh.bounds)
        uploader.send(g)
        pieces.push(g)
        t += CHUNK_TRIS
      } while (t < total && performance.now() - t0 < UPLOAD_SLICE_MS)
      if (t < total) { timer = window.setTimeout(step, 0); return }
      for (const g of pieces) {
        const m = new Mesh(g, matRef.current)
        m.raycast = noRaycast
        group.add(m)
        made.push(m)
      }
      setChunksDone(true)
      invalidate()
    }
    // the first slice waits for the frame that shows the low-res copy
    const raf = requestAnimationFrame(() => { timer = window.setTimeout(step, 0) })
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); uploader.dispose(); for (const m of made) group.remove(m); for (const g of pieces) g.dispose() }
  }, [chunked, body, invalidate, gl, lodGeo])
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
          <group ref={fullRef as never} scale={chunksDone ? 1 : 0} />
        )}
        <mesh
          ref={chunked ? undefined : (fullRef as never)}
          geometry={geo}
          material={chunked ? HIDDEN : bodyMat}
          // three uploads the geometry of every mesh it walks, even one with an invisible material, so the picking mesh of a
          // chunked body is switched off for the renderer (a Raycaster ignores `visible`): no 70 MB upload in one frame
          visible={!chunked}
          raycast={meshRaycast}
          onPointerDown={dragging ? (e) => { if (e.button === 0) { e.stopPropagation(); beginDrag(e, inst) } } : undefined}
          onPointerMove={
            snapping
              ? (e) => { e.stopPropagation(); const s = snapAt(e); useAssemblyRuntime.getState().setSnapHover(s ? { inst: inst.key, index: s.nearest, near: s.near } : null) }
              : faceEdges && canPick ? (e) => { if (e.intersections.some((h) => h.object.type === 'LineSegments')) return; e.stopPropagation(); const r = refFor(e); if (!sameRef(useUi.getState().hover, r)) setHover(r) }
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
              : faceEdges && canPick ? (e) => { if (e.intersections.some((h) => h.object.type === 'LineSegments')) return; e.stopPropagation(); onFaceEdges!(refFor(e)) }
              : pickFaces && canPick ? (e) => { e.stopPropagation(); const r = refFor(e); useLastPick.setState((s) => ({ point: [e.point.x, e.point.y, e.point.z], ref: r, seq: s.seq + 1 })); setSelection([r], e.shiftKey || e.ctrlKey) } : undefined
          }
        />
        {wholeBody && <mesh geometry={showLod ? lodGeo! : geo} material={mats.hi} raycast={() => null} renderOrder={2} />}
        {overlayGeo && <mesh geometry={overlayGeo} material={mats.hi} raycast={() => null} renderOrder={2} />}
        {showEdges && <EdgeLines body={body} inst={inst} color={colors.edge} accent={colors.sel} pickable={filter === 'edge' && !sketching && pickable && !snapping && !dragging} clip={mats.base.clippingPlanes ?? []} />}
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
