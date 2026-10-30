/** Live feature previews: translucent result/tool meshes, profile picking, and the distance-arrow manipulator. */
import { markGrab } from './touchGrab'
import { useDevice } from '@/app/device'
import { Tip } from '@/ui/Tooltip'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Html } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BufferAttribute, BufferGeometry, DoubleSide, MathUtils, Quaternion, Ray, Raycaster, Vector2, Vector3,
  type Group, type OrthographicCamera, type PerspectiveCamera,
} from 'three'
import { create } from 'zustand'
import { useDoc } from '@/doc/store'
import type { MeshData } from '@/kernel/types'
import { Line } from '@react-three/drei'
import { useSketchData, profileGeometry } from '@/sketch/draw'
import { chainsOf, curveRef } from '@/features/surface/curves'
import { loopPoly } from '@/sketch/geom'
import { toWorld } from '@/sketch/plane'
import { planeQuaternion } from '@/sketch/plane'
import { useSketch } from '@/sketch/store'
import { evalNumber } from '@/doc/params'
import { useUi } from '@/store/ui'
import { acceptInspector } from '@/ui/accept'
import { useVpColors } from './colors'

// ---------------------------------------------------------------- mesh previews

export interface PreviewItem { mesh: MeshData; kind: 'add' | 'cut' | 'result' }
/** `hidden`: bodies not drawn while the preview stands in for them. `dim`: bodies drawn faint but still pickable, so more faces can be clicked while the dialog is open. */
interface PreviewState { items: PreviewItem[]; hidden: string[]; dim: string[] }
export const usePreview = create<PreviewState>(() => ({ items: [], hidden: [], dim: [] }))
export const setPreview = (items: PreviewItem[], hidden: string[] = [], dim: string[] = []) => usePreview.setState({ items, hidden, dim })
export const clearPreview = () => usePreview.setState({ items: [], hidden: [], dim: [] })

function PreviewMesh({ item }: { item: PreviewItem }) {
  const colors = useVpColors()
  const geo = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(item.mesh.positions, 3))
    g.setAttribute('normal', new BufferAttribute(item.mesh.normals, 3))
    g.setIndex(new BufferAttribute(item.mesh.indices, 1))
    return g
  }, [item.mesh])
  useEffect(() => () => geo.dispose(), [geo])
  const color = item.kind === 'cut' ? '#d9625a' : colors.accent
  return (
    <mesh geometry={geo} renderOrder={4} raycast={() => null}>
      <meshStandardMaterial color={color} transparent opacity={item.kind === 'result' ? 0.78 : 0.5} roughness={0.6} side={DoubleSide} depthWrite={false} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-1} />
    </mesh>
  )
}

export function PreviewLayer() {
  const items = usePreview((s) => s.items)
  return <>{items.map((it, i) => <PreviewMesh key={i} item={it} />)}</>
}

// ---------------------------------------------------------------- profile picking

interface PickState { active: boolean; selected: string[]; toggle: ((ref: string) => void) | null }
export const useProfilePick = create<PickState>(() => ({ active: false, selected: [], toggle: null }))

export function ProfilePicker() {
  const pick = useProfilePick()
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const hidden = useUi((s) => s.hiddenIds)
  const data = useSketchData((s) => s.data)
  const sketching = useSketch((s) => s.active)
  const colors = useVpColors()
  const [hover, setHover] = useState<string | null>(null)
  const items = useMemo(() => {
    const out: { ref: string; geo: BufferGeometry; q: Quaternion; origin: [number, number, number]; normal: [number, number, number] }[] = []
    features.forEach((f, i) => {
      const d = data[f.id]
      if (f.type !== 'sketch' || !d || i >= rollback || f.suppressed || hidden[f.id]) return
      const q = planeQuaternion(d.plane)
      for (const p of d.profiles) out.push({ ref: `prof:${f.id}:${p.key}${p.id ? '@' + p.id : ''}`, geo: profileGeometry(p), q, origin: d.plane.origin, normal: d.plane.normal })
    })
    return out
  }, [features, rollback, hidden, data])
  useEffect(() => () => items.forEach((i) => i.geo.dispose()), [items])
  if (!pick.active || sketching) return null
  return (
    <>
      {items.map((it) => {
        const sel = pick.selected.includes(it.ref)
        const hot = hover === it.ref
        return (
          <mesh
            key={it.ref}
            geometry={it.geo}
            quaternion={it.q}
            position={[it.origin[0] + it.normal[0] * 0.02, it.origin[1] + it.normal[1] * 0.02, it.origin[2] + it.normal[2] * 0.02]}
            renderOrder={3}
            onPointerMove={(e) => { e.stopPropagation(); if (hover !== it.ref) setHover(it.ref) }}
            onPointerOut={() => setHover(null)}
            onClick={(e) => { e.stopPropagation(); pick.toggle?.(it.ref) }}
          >
            <meshBasicMaterial color={sel || hot ? colors.sel : colors.accent} transparent opacity={sel ? 0.5 : hot ? 0.36 : 0.14} side={DoubleSide} depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
          </mesh>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------- curve picking

/** The curves a surface tool has picked so far (the tool's preview publishes them; picking itself goes through the selection). */
export const useCurvePick = create<{ selected: string[] }>(() => ({ selected: [] }))

/** Finished sketch curves as thick lines to click while the active Inspector field takes curves: a click puts a `curve` entry in the selection. */
export function CurvePicker() {
  const on = useUi((s) => s.pickCurves)
  const selected = useCurvePick((s) => s.selected)
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const hidden = useUi((s) => s.hiddenIds)
  const data = useSketchData((s) => s.data)
  const sketching = useSketch((s) => s.active)
  const colors = useVpColors()
  const [hover, setHover] = useState<string | null>(null)
  const items = useMemo(() => {
    const out: { ref: string; pts: [number, number, number][] }[] = []
    features.forEach((f, i) => {
      const d = data[f.id]
      if (f.type !== 'sketch' || !d || i >= rollback || f.suppressed || hidden[f.id]) return
      for (const c of chainsOf(d)) {
        const poly = loopPoly(c.segs, Math.PI / 48)
        const last = c.segs[c.segs.length - 1]
        const pts = c.closed ? [...poly, poly[0]] : [...poly, last.k === 'c' ? poly[0] : last.b]
        out.push({ ref: curveRef(f.id, c), pts: pts.map((p) => toWorld(d.plane, p)) })
      }
    })
    return out
  }, [features, rollback, hidden, data])
  if (!on || sketching) return null
  return (
    <>
      {items.map((it) => {
        const sel = selected.includes(it.ref)
        const hot = hover === it.ref
        return (
          <group key={it.ref}>
            <Line points={it.pts} color={sel ? (colors.custom ? colors.sel : '#ffffff') : hot ? (colors.custom ? colors.hover : '#e8b84a') : colors.accent} lineWidth={sel ? 4 : hot ? 3.5 : 2.5} renderOrder={8} depthTest={false} raycast={() => null} />
            <Line
              points={it.pts} color={colors.accent} lineWidth={14} transparent opacity={0} depthWrite={false} renderOrder={8}
              onPointerMove={(e) => { e.stopPropagation(); if (hover !== it.ref) setHover(it.ref) }}
              onPointerOut={() => setHover(null)}
              onClick={(e) => { e.stopPropagation(); useUi.getState().setSelection([{ kind: 'curve', id: it.ref }]) }}
            />
          </group>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------- distance arrow

interface ManipState {
  active: boolean
  origin: [number, number, number]
  dir: [number, number, number]
  /** distance of the arrow tip from the origin along dir */
  tip: number
  /** parameter value = tip * factor */
  factor: number
  label: (value: number) => string
  onChange: ((value: number) => void) | null
}
export const useManip = create<ManipState>(() => ({ active: false, origin: [0, 0, 0], dir: [0, 0, 1], tip: 10, factor: 1, label: (v) => v.toFixed(2), onChange: null }))
export const resetManip = () => useManip.setState({ active: false, onChange: null })

/** Parameter along the line (o, d) of the point closest to the pointer ray. */
function axisParam(ray: Ray, o: Vector3, d: Vector3): number | null {
  const w0 = o.clone().sub(ray.origin)
  const b = d.dot(ray.direction)
  const dd = d.dot(w0), e = ray.direction.dot(w0)
  const den = 1 - b * b
  if (Math.abs(den) < 1e-6) return null
  return (b * e - dd) / den
}

export function ArrowManipulator() {
  const m = useManip()
  const colors = useVpColors()
  const group = useRef<Group>(null)
  const { camera, gl, invalidate } = useThree()
  const drag = useRef<{ t0: number; tip0: number } | null>(null)
  const quat = useMemo(() => new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...m.dir).normalize()), [m.dir])
  const [hot, setHot] = useState(false)
  const coarse = useDevice((d) => d.coarse)
  const [typing, setTyping] = useState<string | null>(null)
  useEffect(() => { if (!m.active) setTyping(null) }, [m.active])
  /** Enter in the value box: take the typed distance, then accept the dialog like OK does. */
  const commitTyped = (text: string) => {
    const v = evalNumber(text, 'mm')
    if (v === null || !Number.isFinite(v)) return false
    useManip.getState().onChange?.(+v.toFixed(4))
    setTyping(null)
    setTimeout(() => acceptInspector(), 0)
    return true
  }

  // constant on-screen size
  useFrame((state) => {
    const g = group.current
    if (!g) return
    const cam = state.camera as PerspectiveCamera & OrthographicCamera
    const p = new Vector3(...m.origin).addScaledVector(new Vector3(...m.dir), m.tip)
    const s = cam.isOrthographicCamera ? 46 / cam.zoom : (cam.position.distanceTo(p) * 2 * Math.tan(MathUtils.degToRad(cam.fov) / 2) * 46) / state.size.height
    g.scale.setScalar(s)
  })

  const rayAt = (e: PointerEvent) => {
    const r = gl.domElement.getBoundingClientRect()
    const rc = new Raycaster()
    rc.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
    return rc.ray
  }
  const onDown = (e: { stopPropagation(): void; nativeEvent: PointerEvent }) => {
    e.stopPropagation()
    markGrab()
    const o = new Vector3(...m.origin), d = new Vector3(...m.dir).normalize()
    const t0 = axisParam(rayAt(e.nativeEvent), o, d)
    if (t0 === null) return
    drag.current = { t0, tip0: m.tip }
    const move = (ev: PointerEvent) => {
      const dr = drag.current
      if (!dr) return
      const t = axisParam(rayAt(ev), o, d)
      if (t === null) return
      // the tool may turn the arrow round mid-drag (Extrude flips Join / Cut): measure on the axis the drag began on, then read the
      // tip off in whatever direction the arrow points now, so it never jumps
      const cur = useManip.getState()
      const flip = new Vector3(...cur.dir).normalize().dot(d) < 0 ? -1 : 1
      const along = dr.tip0 + (t - dr.t0)
      const st = ev.shiftKey ? 1 : 0.1
      const v = Math.round((along * flip * cur.factor) / st) * st
      cur.onChange?.(+v.toFixed(4))
      invalidate()
    }
    const up = () => {
      drag.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!m.active) return null
  const color = hot ? colors.sel : '#e8b84a'
  return (
    <group position={m.origin} quaternion={quat}>
      <group position={[0, 0, m.tip]}>
        <group ref={group}>
          <mesh position={[0, 0, -0.6]} rotation={[Math.PI / 2, 0, 0]} renderOrder={30}>
            <cylinderGeometry args={[0.04, 0.04, 1.2, 8]} />
            <meshBasicMaterial color={color} depthTest={false} transparent />
          </mesh>
          <mesh position={[0, 0, 0.25]} rotation={[Math.PI / 2, 0, 0]} renderOrder={30}>
            <coneGeometry args={[0.16, 0.5, 16]} />
            <meshBasicMaterial color={color} depthTest={false} transparent />
          </mesh>
          {/* generous hit area */}
          <mesh
            position={[0, 0, -0.2]}
            rotation={[Math.PI / 2, 0, 0]}
            userData={{ handle: true }}
            onPointerDown={onDown as never}
            onPointerOver={() => { setHot(true); gl.domElement.style.cursor = 'grab' }}
            onPointerOut={() => { setHot(false); gl.domElement.style.cursor = '' }}
          >
            {/* (a fingertip needs a much fatter target than a mouse pointer) */}
            <cylinderGeometry args={coarse ? [0.95, 0.95, 2.4, 8] : [0.32, 0.32, 1.6, 8]} />
            <meshBasicMaterial visible={false} />
          </mesh>
        </group>
        <Html position={[0, 0, 0]} zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
          {typing === null ? (
            <Tip label="Type a value" desc="Click to type an exact value, then press Enter to accept it." side="top">
              <div className="sk-tip" data-testid="manip-value" style={{ transform: 'translate(14px, -26px)', pointerEvents: 'auto', cursor: 'text' }}
                onClick={() => setTyping(String(+(m.tip * m.factor).toFixed(3)))}>{m.label(m.tip * m.factor)}</div>
            </Tip>
          ) : (
            <input className="sk-tip sk-tip-input" data-testid="manip-input" data-accept-on-enter autoFocus value={typing} spellCheck={false} inputMode={coarse ? 'decimal' : undefined} enterKeyHint="done"
              style={{ transform: 'translate(14px, -26px)', pointerEvents: 'auto', width: 84 }}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setTyping(e.target.value)}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') { e.preventDefault(); commitTyped(typing) }
                else if (e.key === 'Escape') setTyping(null)
              }}
              onBlur={() => setTyping(null)} />
          )}
        </Html>
      </group>
    </group>
  )
}
