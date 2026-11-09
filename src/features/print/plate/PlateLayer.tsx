/** The bed in the 3D view (plate surface, outline, origin, build volume) and the gizmo that moves or turns the selected part. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { TransformControls, Line } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { BufferGeometry, CanvasTexture, DoubleSide, ExtrudeGeometry, Float32BufferAttribute, LinearMipmapLinearFilter, Matrix4, Mesh, Path, Plane, Quaternion, Raycaster, RepeatWrapping, Shape, SRGBColorSpace, Vector2, Vector3, type Group } from 'three'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { useDevice } from '@/app/device'
import { eulerFromMatrix } from '@/kernel/print-geom'
import { usePlateXf } from '@/viewport/plateXf'
import { markGrab, registerFingerOwner } from '@/viewport/touchGrab'
import { useSlice } from '../engine/sliceStore'
import { eulerMatrix, mul3, type BedShape } from './model'
import { faceRegion } from './faceRegion'
import { layOnNormal } from './ops'
import { commitPlacements, getPlateModel, useBed, usePlate, usePlateModel, useStage } from './store'
import { usePlateActive } from './sync'

/** One 50 mm tile of the plate: a fine PEI-like finish, 10 mm grid lines and a stronger line on the tile edge (every 50 mm). */
function plateTexture(dark: boolean): CanvasTexture {
  const N = 512
  const c = document.createElement('canvas')
  c.width = c.height = N
  const g = c.getContext('2d')!
  g.fillStyle = dark ? '#48525a' : '#e6ebee'
  g.fillRect(0, 0, N, N)
  // a pseudo-random speckle (seeded, so every tile and every reload looks the same)
  let s = 7
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 2200; i++) {
    g.fillStyle = dark ? `rgba(255,255,255,${(rnd() * 0.035).toFixed(3)})` : `rgba(0,0,0,${(rnd() * 0.04).toFixed(3)})`
    g.fillRect(rnd() * N, rnd() * N, 1 + rnd() * 1.6, 1 + rnd() * 1.6)
  }
  const line = dark ? '255,255,255' : '20,40,50'
  g.fillStyle = `rgba(${line},${dark ? 0.12 : 0.13})`
  for (let i = 1; i < 5; i++) { const p = Math.round((i * N) / 5); g.fillRect(p - 1, 0, 2, N); g.fillRect(0, p - 1, N, 2) }
  g.fillStyle = `rgba(${line},${dark ? 0.28 : 0.26})`
  g.fillRect(0, 0, N, 3)
  g.fillRect(0, 0, 3, N)
  const t = new CanvasTexture(c)
  t.wrapS = t.wrapT = RepeatWrapping
  t.repeat.set(1 / 50, 1 / 50)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 8
  t.minFilter = LinearMipmapLinearFilter
  return t
}

/** Where the bed sits in the world: at the origin, or (an assembly, whose bodies are laid out when sliced) under the bodies. */
function useBedOffset(stage: 'prepare' | 'preview', plateOn: boolean, bed: BedShape): [number, number, number] {
  const bedOrigin = useSlice((s) => s.bedOrigin)
  const geometry = useDoc((s) => s.geometry)
  const hidden = useUi((s) => s.hiddenIds)
  return useMemo(() => {
    if (stage === 'preview') return bedOrigin ?? [0, 0, 0]
    if (plateOn) return [0, 0, 0]
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (const b of geometry) {
      if (hidden[b.id] || b.surface) continue
      const p = b.mesh.positions
      for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < lo[k]) lo[k] = p[i + k]; if (p[i + k] > hi[k]) hi[k] = p[i + k] }
    }
    if (!isFinite(lo[0])) return [0, 0, 0]
    return [(lo[0] + hi[0]) / 2 - (bed.lo[0] + bed.hi[0]) / 2, (lo[1] + hi[1]) / 2 - (bed.lo[1] + bed.hi[1]) / 2, lo[2]]
  }, [stage, plateOn, bedOrigin, geometry, hidden, bed])
}

export function BedLayer() {
  const workspace = useUi((s) => s.workspace)
  const theme = useUi((s) => s.theme)
  const stage = useStage()
  const plateOn = usePlateActive()
  const bed = useBed()
  const offset = useBedOffset(stage, plateOn, bed)
  const dark = theme === 'dark'
  const invalidate = useThree((s) => s.invalidate)
  const tex = useMemo(() => plateTexture(dark), [dark])
  // the plate is a 3 mm slab (its top just under z = 0) with a thin raised rim round the edge
  const slab = useMemo(() => new ExtrudeGeometry(new Shape(bed.poly.map((p) => ({ x: p[0], y: p[1] })) as never), { depth: 3, bevelEnabled: false }), [bed])
  const rim = useMemo(() => {
    const outer = new Shape(bed.poly.map((p) => ({ x: p[0], y: p[1] })) as never)
    const cx = (bed.lo[0] + bed.hi[0]) / 2, cy = (bed.lo[1] + bed.hi[1]) / 2
    const k = 1 - 3 / Math.max(10, Math.min(bed.hi[0] - bed.lo[0], bed.hi[1] - bed.lo[1]))
    const hole = new Path(bed.poly.map((p) => ({ x: cx + (p[0] - cx) * k, y: cy + (p[1] - cy) * k })) as never)
    outer.holes.push(hole)
    return new ExtrudeGeometry(outer, { depth: 0.9, bevelEnabled: false })
  }, [bed])
  const volume = useMemo(() => {
    const h = bed.height
    const pos: number[] = []
    const n = bed.poly.length
    for (let i = 0; i < n; i++) {
      const a = bed.poly[i], b = bed.poly[(i + 1) % n]
      pos.push(a[0], a[1], h, b[0], b[1], h)
    }
    // posts at the corners (a round bed has too many points: a handful of them)
    const stepN = Math.max(1, Math.ceil(n / 8))
    for (let i = 0; i < n; i += stepN) pos.push(bed.poly[i][0], bed.poly[i][1], 0, bed.poly[i][0], bed.poly[i][1], h)
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(pos, 3))
    return g
  }, [bed])
  const loop = useMemo(() => [...bed.poly, bed.poly[0]].map((p) => [p[0], p[1], 0.95] as [number, number, number]), [bed])
  useEffect(() => () => { slab.dispose(); rim.dispose(); volume.dispose(); tex.dispose() }, [slab, rim, volume, tex])
  useEffect(() => { invalidate() }, [bed, offset, dark, invalidate])
  // the plate is a Print thing: other workspaces keep their own grid
  if (workspace !== 'print') return null
  const O = bed.lo
  return (
    <group name="print-bed" position={offset} userData={{ noAo: true }}>
      <mesh geometry={slab} position={[0, 0, -3.06]} raycast={() => null}>
        <meshStandardMaterial attach="material-0" map={tex} roughness={0.8} metalness={0.05} polygonOffset polygonOffsetFactor={2} polygonOffsetUnits={2} />
        <meshStandardMaterial attach="material-1" color={dark ? '#252a2d' : '#c3ccd1'} roughness={0.7} />
      </mesh>
      <mesh geometry={rim} position={[0, 0, -0.06]} raycast={() => null}>
        <meshStandardMaterial color={dark ? '#8a9aa2' : '#9aa9b0'} roughness={0.55} metalness={0.15} />
      </mesh>
      <Line points={loop} color={dark ? '#7fe3b9' : '#2f9e73'} lineWidth={1.6} transparent opacity={0.85} raycast={() => null} />
      <lineSegments geometry={volume} raycast={() => null}>
        <lineBasicMaterial color={dark ? '#9fb4be' : '#5b6b73'} transparent opacity={0.22} depthWrite={false} />
      </lineSegments>
      {/* the origin of the bed: X red, Y green */}
      <Line points={[[O[0] + 4, O[1] + 4, 0.1], [O[0] + 24, O[1] + 4, 0.1]]} color="#ff6b6b" lineWidth={2.4} raycast={() => null} />
      <Line points={[[O[0] + 4, O[1] + 4, 0.1], [O[0] + 4, O[1] + 24, 0.1]]} color="#6bd66b" lineWidth={2.4} raycast={() => null} />
    </group>
  )
}

/** The move / rotate handles on the selected part. Z is locked to the bed: a part only slides on it or turns, then drops back. */
export function PlateGizmo() {
  const on = usePlateActive()
  const stage = useStage()
  const tool = usePlate((s) => s.tool)
  const plate = usePlateModel()
  const coarse = useDevice((d) => d.coarse)
  const selection = useUi((s) => s.selection)
  const ref = useRef<Group>(null)
  const tcRef = useRef<{ axis?: string | null } | null>(null)
  gizmoAxis = () => tcRef.current?.axis ?? null
  const start = useRef<{ r: [number, number, number]; x: number; y: number } | null>(null)
  const id = useMemo(() => {
    const ids = new Set(plate.list.map((p) => p.id))
    return selection.find((r) => ids.has(r.id))?.id ?? null
  }, [selection, plate.list])
  const part = plate.list.find((p) => p.id === id)
  if (!on || stage !== 'prepare' || !part || tool === 'face') return null
  const centre: [number, number, number] = [part.entry.x, part.entry.y, part.size[2] / 2]
  const down = () => {
    markGrab()
    start.current = { r: part.entry.r, x: part.entry.x, y: part.entry.y }
  }
  const change = () => {
    const o = ref.current, s = start.current
    if (!o || !s) return
    if (tool === 'move') {
      o.position.z = centre[2]
      usePlate.setState({ live: { [part.id]: { r: s.r, x: +o.position.x.toFixed(3), y: +o.position.y.toFixed(3) } } })
    } else {
      const dm = new Matrix4().makeRotationFromQuaternion(new Quaternion().copy(o.quaternion)).elements
      const D = [dm[0], dm[4], dm[8], dm[1], dm[5], dm[9], dm[2], dm[6], dm[10]]
      const r = eulerFromMatrix(mul3(D, eulerMatrix(s.r))).map((v) => +v.toFixed(3)) as [number, number, number]
      usePlate.setState({ live: { [part.id]: { r, x: s.x, y: s.y } } })
    }
  }
  const up = () => {
    const live = usePlate.getState().live[part.id]
    if (ref.current) { ref.current.rotation.set(0, 0, 0); ref.current.quaternion.identity() }
    start.current = null
    if (!live) return
    commitPlacements({ [part.id]: live }, tool === 'move' ? 'Move part' : 'Rotate part', Object.fromEntries(plate.list.map((p) => [p.id, p.entry])))
  }
  return (
    <>
      {/* the handles attach to this group (a child of TransformControls would be attached through a wrapper at the origin) */}
      <group ref={ref} position={centre} />
      <TransformControls
        ref={tcRef as never} object={ref as never} mode={tool === 'rotate' ? 'rotate' : 'translate'} space="world" size={coarse ? 1.4 : 0.9}
        showZ={tool === 'rotate'} rotationSnap={tool === 'rotate' ? Math.PI / 36 : null}
        onMouseDown={down} onMouseUp={up} onObjectChange={change}
      />
    </>
  )
}

/** What the gizmo is hovering: a press on a handle is the gizmo's, not a drag of the part. */
let gizmoAxis: () => string | null = () => null

/**
 * Drag a part along the bed: press on it, drag, it slides in X and Y under the pointer (the point you grabbed stays under it, on the
 * plane through that point). Shift rounds to 1 mm. One undo step per drag. Mouse and touch; the camera does not orbit meanwhile.
 */
export function PlateDrag() {
  const on = usePlateActive()
  const stage = useStage()
  const tool = usePlate((s) => s.tool)
  const { gl, camera, scene } = useThree()
  const active = on && stage === 'prepare' && tool !== 'face'
  useEffect(() => {
    if (!active) return
    const el = gl.domElement
    const rc = new Raycaster()
    const ndc = (e: PointerEvent) => { const r = el.getBoundingClientRect(); return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1) }
    let drag: { id: string; pointer: number; plane: Plane; dx: number; dy: number; r: [number, number, number]; x0: number; y0: number; sx: number; sy: number; moved: boolean } | null = null
    const unown = registerFingerOwner(() => !!drag)
    const atPlane = (e: PointerEvent, plane: Plane) => { rc.setFromCamera(ndc(e), camera); return rc.ray.intersectPlane(plane, new Vector3()) }
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (!e.isPrimary || gizmoAxis()) return
      const root = scene.getObjectByName('bodies')
      if (!root) return
      rc.setFromCamera(ndc(e), camera)
      const hit = rc.intersectObjects(root.children, true).find((h) => (h.object as Mesh).isMesh && h.object.visible && (h.object as Mesh).geometry?.getAttribute?.('position'))
      if (!hit) return
      const arr = (hit.object as Mesh).geometry.getAttribute('position').array
      const part = getPlateModel().list.find((p) => getPlateModel().bodies.find((b) => b.id === p.id)?.mesh.positions === arr)
      if (!part) return
      const plane = new Plane(new Vector3(0, 0, 1), -hit.point.z)
      drag = { id: part.id, pointer: e.pointerId, plane, dx: part.entry.x - hit.point.x, dy: part.entry.y - hit.point.y, r: part.entry.r, x0: part.entry.x, y0: part.entry.y, sx: e.clientX, sy: e.clientY, moved: false }
      markGrab()
      useUi.getState().setSelection([{ kind: 'body', id: part.id }])
    }
    const move = (e: PointerEvent) => {
      const d = drag
      if (!d || e.pointerId !== d.pointer) return
      markGrab()
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return
        d.moved = true
        try { el.setPointerCapture(e.pointerId) } catch { /* the pointer is gone */ }
      }
      const p = atPlane(e, d.plane)
      if (!p) return
      let x = p.x + d.dx, y = p.y + d.dy
      if (e.shiftKey) { x = Math.round(x); y = Math.round(y) }
      usePlate.setState({ live: { [d.id]: { r: d.r, x: +x.toFixed(3), y: +y.toFixed(3) } } })
    }
    const up = (e: PointerEvent) => {
      const d = drag
      if (!d || e.pointerId !== d.pointer) return
      drag = null
      try { el.releasePointerCapture(e.pointerId) } catch { /* released */ }
      const live = usePlate.getState().live[d.id]
      if (!d.moved || !live) return
      const model = getPlateModel()
      commitPlacements({ [d.id]: live }, 'Move part', Object.fromEntries(model.list.map((p) => [p.id, p.entry])))
    }
    el.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      unown()
      usePlate.setState({ live: {} })
    }
  }, [active, gl, camera, scene])
  return null
}

/**
 * Lay on face: hover shows the whole flat face under the pointer (a B-rep face, or the connected coplanar triangles of a mesh), a
 * click lays the part on it. The pick is ours (not the generic face selection) so the region is always the full planar area.
 */
export function PlateFaceTool() {
  const on = usePlateActive()
  const stage = useStage()
  const tool = usePlate((s) => s.tool)
  const { gl, camera, scene, invalidate } = useThree()
  const active = on && stage === 'prepare' && tool === 'face'
  const [shown, setShown] = useState<{ geo: BufferGeometry; matrix: Matrix4 } | null>(null)
  const meshRef = useRef<Mesh>(null)
  useEffect(() => {
    if (!active) return
    usePlateXf.setState({ facePick: true })
    const el = gl.domElement
    const rc = new Raycaster()
    let last: { geo: BufferGeometry; id: string; normal: [number, number, number] } | null = null
    let key = ''
    const clear = () => { last?.geo.dispose(); last = null; key = ''; setShown(null) }
    const pick = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      rc.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
      const root = scene.getObjectByName('bodies')
      if (!root) return null
      const hit = rc.intersectObjects(root.children, true).find((h) => (h.object as Mesh).isMesh && h.object.visible && (h.object as Mesh).geometry?.getAttribute?.('position') && h.faceIndex != null)
      if (!hit) return null
      const geo = (hit.object as Mesh).geometry
      const body = getPlateModel().bodies.find((b) => b.mesh.positions === geo.getAttribute('position').array)
      if (!body) return null
      const region = faceRegion(body.mesh, hit.faceIndex!)
      return region ? { body, region, geo, matrix: hit.object.matrixWorld.clone() } : null
    }
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return
      const p = pick(e)
      if (!p) { if (last) { clear(); invalidate() } return }
      const k = `${p.body.id}:${Math.min(...p.region.tris)}:${p.region.tris.length}`
      if (k === key) return
      const idx: number[] = []
      for (const t of p.region.tris) idx.push(p.body.mesh.indices[t * 3], p.body.mesh.indices[t * 3 + 1], p.body.mesh.indices[t * 3 + 2])
      const g = new BufferGeometry()
      g.setAttribute('position', p.geo.getAttribute('position'))
      g.setIndex(idx)
      last?.geo.dispose()
      last = { geo: g, id: p.body.id, normal: p.region.normal }
      key = k
      setShown({ geo: g, matrix: p.matrix })
      invalidate()
    }
    let down: { x: number; y: number } | null = null
    const pdown = (e: PointerEvent) => { down = e.button === 0 && e.isPrimary ? { x: e.clientX, y: e.clientY } : null }
    const up = (e: PointerEvent) => {
      const d = down
      down = null
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return
      const p = pick(e)
      if (!p) return
      void layOnNormal(p.body.id, p.region.normal)
      useUi.getState().setSelection([{ kind: 'body', id: p.body.id }])
      usePlate.setState({ tool: 'move' })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerleave', clear)
    el.addEventListener('pointerdown', pdown)
    el.addEventListener('pointerup', up)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerleave', clear)
      el.removeEventListener('pointerdown', pdown)
      el.removeEventListener('pointerup', up)
      usePlateXf.setState({ facePick: false })
      clear()
    }
  }, [active, gl, camera, scene, invalidate])
  useEffect(() => {
    const m = meshRef.current
    if (!m || !shown) return
    m.matrixAutoUpdate = false
    m.matrix.copy(shown.matrix)
    m.matrixWorldNeedsUpdate = true
    invalidate()
  }, [shown, invalidate])
  if (!active || !shown) return null
  return (
    <mesh ref={meshRef} geometry={shown.geo} raycast={() => null} renderOrder={5} name="face-region" userData={{ noAo: true }}>
      <meshBasicMaterial color="#2f9bff" transparent opacity={0.55} depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} side={DoubleSide} />
    </mesh>
  )
}

export function PlateCanvas() {
  return (
    <>
      <BedLayer />
      <PlateDrag />
      <PlateGizmo />
      <PlateFaceTool />
    </>
  )
}
