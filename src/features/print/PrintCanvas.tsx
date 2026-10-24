/** Print overlays inside the 3D canvas: painted colors, analysis maps, split plane and drain holes. */
import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, DoubleSide, Matrix4, Quaternion, Raycaster, Vector2, Vector3, type Mesh } from 'three'
import { useDoc } from '@/doc/store'
import { composeTransform, type Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import { sectionPlane } from '@/viewport/section'
import { useMove } from '../move'
import { computePaintMap, usePendingPaint, type PaintMap } from './paint'
import { slotHex, settingsOf } from './settings'
import { useDrains, type Drain } from './hollow'
import { useSplitView } from './split'
import { SMALL_COLOR, severityColor, usePrintView } from './view'

/** Triangles of `body` whose slot is `slot`, as an index list into the body's own vertices. */
function slotGeometry(body: Body, slots: Uint8Array, slot: number): BufferGeometry | null {
  const idx: number[] = []
  const src = body.mesh.indices
  for (let t = 0; t < slots.length; t++) if (slots[t] === slot) idx.push(src[t * 3], src[t * 3 + 1], src[t * 3 + 2])
  if (!idx.length) return null
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(body.mesh.positions, 3))
  g.setAttribute('normal', new BufferAttribute(body.mesh.normals, 3))
  g.setIndex(idx)
  return g
}

function useBodyMatrix(bodyId: string) {
  const move = useMove()
  return useMemo(() => {
    if (!move.active || !move.bodyIds.includes(bodyId)) return null
    return new Matrix4().fromArray(composeTransform({ pivot: move.pivot, translate: move.translate, rotate: move.rotate, scale: move.scale }))
  }, [move.active, move.bodyIds, move.pivot, move.translate, move.rotate, move.scale, bodyId])
}

function PaintedBody({ body, map, colors, clip, opacity }: { body: Body; map: Uint8Array; colors: Record<number, string>; clip: ReturnType<typeof sectionPlane>[]; opacity: number }) {
  const { invalidate } = useThree()
  const geos = useMemo(() => {
    const out: { slot: number; geo: BufferGeometry }[] = []
    for (const slot of new Set(map)) {
      if (!slot) continue
      const g = slotGeometry(body, map, slot)
      if (g) out.push({ slot, geo: g })
    }
    return out
  }, [body, map])
  useEffect(() => { invalidate(); return () => geos.forEach((g) => g.geo.dispose()) }, [geos, invalidate])
  const matrix = useBodyMatrix(body.id)
  return (
    <group matrixAutoUpdate={matrix === null} matrix={matrix ?? undefined} name="print-paint">
      {geos.map((g) => (
        <mesh key={g.slot} geometry={g.geo} renderOrder={1} raycast={() => null}>
          <meshStandardMaterial color={colors[g.slot] ?? '#ffffff'} roughness={0.55} metalness={0} side={DoubleSide} transparent={opacity < 1} opacity={opacity} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} clippingPlanes={clip} />
        </mesh>
      ))}
    </group>
  )
}

/** Painted bodies and faces in their filament colors. */
export function PaintLayer() {
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const geometry = useDoc((s) => s.geometry)
  const hidden = useUi((s) => s.hiddenIds)
  const mode = useUi((s) => s.displayMode)
  const section = useUi((s) => s.section)
  const pending = usePendingPaint((s) => s.map)
  const map: PaintMap = useMemo(() => computePaintMap(features, rollback, geometry), [features, rollback, geometry])
  const settings = useMemo(() => settingsOf(features, rollback), [features, rollback])
  const colors = useMemo(() => Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 1, slotHex(settings, i + 1)])), [settings])
  const clip = useMemo(() => (section.on ? [sectionPlane(section)] : []), [section])
  if (mode === 'wireframe') return null
  const opacity = mode === 'xray' ? 0.4 : 1
  return (
    <group name="print-paint-layer">
      {geometry.map((b) => {
        if (hidden[b.id]) return null
        const m = map.get(b.id)
        return m ? <PaintedBody key={b.key + ':paint'} body={b} map={m} colors={colors} clip={clip} opacity={opacity} /> : null
      })}
      {pending && geometry.map((b) => {
        const m = pending.get(b.id)
        return m && !hidden[b.id] ? <PaintedBody key={b.key + ':pending'} body={b} map={m} colors={colors} clip={clip} opacity={opacity} /> : null
      })}
    </group>
  )
}

/** The flagged triangles of the active printability map, colored by how bad they are. */
export function AnalysisLayer() {
  const result = usePrintView((s) => s.result)
  const hidden = useUi((s) => s.hiddenIds)
  const { invalidate } = useThree()
  const geos = useMemo(() => {
    if (!result) return []
    const out: { id: string; geo: BufferGeometry }[] = []
    for (const bm of result.bodies) {
      const { positions, indices } = bm.mesh
      const tris: number[] = []
      for (let t = 0; t < bm.severity.length; t++) if (bm.severity[t] > 0) tris.push(t)
      if (!tris.length) continue
      const pos = new Float32Array(tris.length * 9), col = new Float32Array(tris.length * 9)
      tris.forEach((t, i) => {
        const c = result.kind === 'small' ? SMALL_COLOR : severityColor(bm.severity[t])
        for (let k = 0; k < 3; k++) {
          const v = indices[t * 3 + k] * 3
          pos.set([positions[v], positions[v + 1], positions[v + 2]], i * 9 + k * 3)
          col.set(c, i * 9 + k * 3)
        }
      })
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(pos, 3))
      g.setAttribute('color', new BufferAttribute(col, 3))
      out.push({ id: bm.bodyId, geo: g })
    }
    return out
  }, [result])
  useEffect(() => { invalidate(); return () => geos.forEach((g) => g.geo.dispose()) }, [geos, invalidate])
  return (
    <group name="print-analysis">
      {geos.map((g) => hidden[g.id] ? null : (
        <mesh key={g.id} geometry={g.geo} renderOrder={6} raycast={() => null} userData={{ noAo: true }}>
          <meshBasicMaterial vertexColors side={DoubleSide} transparent opacity={0.92} depthWrite={false} polygonOffset polygonOffsetFactor={-3} polygonOffsetUnits={-3} />
        </mesh>
      ))}
    </group>
  )
}

const Z = new Vector3(0, 0, 1)

/** A translucent disc / marker oriented along `n`. */
function orient(n: [number, number, number]) {
  return new Quaternion().setFromUnitVectors(Z, new Vector3(...n).normalize())
}

/** The cutting plane of the open Split dialog. */
export function SplitPlaneLayer() {
  const plane = useSplitView((s) => s.plane)
  if (!plane) return null
  return (
    <mesh position={plane.origin} quaternion={orient(plane.normal)} renderOrder={5} raycast={() => null} userData={{ noAo: true }}>
      <planeGeometry args={[plane.size, plane.size]} />
      <meshBasicMaterial color="#d2a24a" transparent opacity={0.16} side={DoubleSide} depthWrite={false} />
    </mesh>
  )
}

/** Markers for the drain holes, and the click-to-add handler. */
export function DrainLayer() {
  const { open, adding, holes, diameter } = useDrains()
  const { gl, camera, scene, invalidate } = useThree()
  useEffect(() => { invalidate() }, [holes, invalidate])
  useEffect(() => {
    if (!open || !adding) return
    const el = gl.domElement
    const rc = new Raycaster()
    const prev = el.style.cursor
    el.style.cursor = 'crosshair'
    let down: { x: number; y: number } | null = null
    const hit = (e: PointerEvent): Drain | null => {
      const r = el.getBoundingClientRect()
      rc.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
      const root = scene.getObjectByName('bodies')
      if (!root) return null
      const h = rc.intersectObjects(root.children, true).find((x) => (x.object as Mesh).isMesh && x.face)
      if (!h || !h.face) return null
      const n = h.face.normal.clone()
      return { p: [h.point.x, h.point.y, h.point.z], n: [n.x, n.y, n.z] }
    }
    const onDown = (e: PointerEvent) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY } }
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !down) return
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4
      down = null
      if (moved) return
      const d = hit(e)
      const st = useDrains.getState()
      if (!d || !st.set) return
      if (e.altKey) {
        // alt + click removes the hole nearest to the click
        let best = -1, bd = Math.max(st.diameter * 1.5, 4)
        st.holes.forEach((h, i) => { const dist = Math.hypot(h.p[0] - d.p[0], h.p[1] - d.p[1], h.p[2] - d.p[2]); if (dist < bd) { bd = dist; best = i } })
        if (best >= 0) st.set(st.holes.filter((_, i) => i !== best))
        return
      }
      st.set([...st.holes, d])
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      el.style.cursor = prev
    }
  }, [open, adding, gl, camera, scene])
  if (!open) return null
  return (
    <group name="print-drains">
      {holes.map((h, i) => (
        <group key={i} position={h.p} quaternion={orient(h.n)}>
          <mesh rotation={[Math.PI / 2, 0, 0]} renderOrder={7} raycast={() => null} userData={{ noAo: true }}>
            <cylinderGeometry args={[diameter / 2, diameter / 2, 0.8, 24]} />
            <meshBasicMaterial color="#d9625a" transparent opacity={0.9} depthTest={false} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

export function PrintCanvas() {
  return (
    <>
      <PaintLayer />
      <AnalysisLayer />
      <SplitPlaneLayer />
      <DrainLayer />
    </>
  )
}
