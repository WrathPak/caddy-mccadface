/** Rotary drag handle for angles (Revolve): a knob on an arc about the axis. Same value box and typing as the distance arrow. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Html, Line } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { MathUtils, Matrix4, Plane, Raycaster, Vector2, Vector3, type Group, type OrthographicCamera, type PerspectiveCamera } from 'three'
import { create } from 'zustand'
import { evalNumber } from '@/doc/params'
import { Tip } from '@/ui/Tooltip'
import { acceptInspector } from '@/ui/accept'
import { useDevice } from '@/app/device'
import { useVpColors } from './colors'
import { markGrab } from './touchGrab'

interface AngleState {
  active: boolean
  /** a point on the axis, level with the start of the arc */
  origin: [number, number, number]
  axis: [number, number, number]
  /** unit vector (perpendicular to the axis) the angle is measured from: towards the profile */
  start: [number, number, number]
  radius: number
  /** degrees */
  angle: number
  onChange: ((deg: number) => void) | null
}
export const useAngleManip = create<AngleState>(() => ({ active: false, origin: [0, 0, 0], axis: [0, 0, 1], start: [1, 0, 0], radius: 10, angle: 360, onChange: null }))
export const resetAngleManip = () => useAngleManip.setState({ active: false, onChange: null })

const MAX = 360

export function AngleManipulator() {
  const m = useAngleManip()
  const colors = useVpColors()
  const knob = useRef<Group>(null)
  const { camera, gl, invalidate } = useThree()
  const coarse = useDevice((d) => d.coarse)
  const [hot, setHot] = useState(false)
  const [typing, setTyping] = useState<string | null>(null)
  useEffect(() => { if (!m.active) setTyping(null) }, [m.active])

  const frame = useMemo(() => {
    const z = new Vector3(...m.axis).normalize()
    const s = new Vector3(...m.start)
    const x = s.addScaledVector(z, -s.dot(z)).normalize()
    const y = new Vector3().crossVectors(z, x)
    return new Matrix4().makeBasis(x, y, z).setPosition(new Vector3(...m.origin))
  }, [m.origin, m.axis, m.start])

  // the knob keeps its size on screen
  useFrame((state) => {
    const g = knob.current
    if (!g) return
    const cam = state.camera as PerspectiveCamera & OrthographicCamera
    const p = g.getWorldPosition(new Vector3())
    g.scale.setScalar(cam.isOrthographicCamera ? 46 / cam.zoom : (cam.position.distanceTo(p) * 2 * Math.tan(MathUtils.degToRad(cam.fov) / 2) * 46) / state.size.height)
  })

  const arc = useMemo(() => {
    const a = Math.max(Math.abs(m.angle), 0.5)
    const n = Math.max(8, Math.ceil(a / 4))
    const sgn = m.angle < 0 ? -1 : 1
    return Array.from({ length: n + 1 }, (_, i): [number, number, number] => {
      const t = (sgn * MathUtils.degToRad(a) * i) / n
      return [Math.cos(t) * m.radius, Math.sin(t) * m.radius, 0]
    })
  }, [m.angle, m.radius])
  const end = MathUtils.degToRad(m.angle)

  const commitTyped = (text: string) => {
    const v = evalNumber(text, 'deg')
    if (v === null || !Number.isFinite(v) || v === 0) return false
    useAngleManip.getState().onChange?.(+MathUtils.clamp(v, -MAX, MAX).toFixed(3))
    setTyping(null)
    setTimeout(() => acceptInspector(), 0)
    return true
  }

  const onDown = (e: { stopPropagation(): void; nativeEvent: PointerEvent }) => {
    e.stopPropagation()
    markGrab()
    const o = new Vector3(...m.origin), z = new Vector3(...m.axis).normalize()
    const inv = frame.clone().invert()
    const plane = new Plane().setFromNormalAndCoplanarPoint(z, o)
    const rc = new Raycaster()
    const aim = (ev: PointerEvent) => {
      const r = gl.domElement.getBoundingClientRect()
      rc.setFromCamera(new Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera)
      const hit = rc.ray.intersectPlane(plane, new Vector3())
      if (!hit) return null
      const l = hit.applyMatrix4(inv)
      return Math.atan2(l.y, l.x)
    }
    let prev = aim(e.nativeEvent)
    if (prev === null) return
    let angle = m.angle
    const move = (ev: PointerEvent) => {
      const a = aim(ev)
      if (a === null || prev === null) return
      let d = a - prev
      if (d > Math.PI) d -= 2 * Math.PI
      else if (d < -Math.PI) d += 2 * Math.PI
      prev = a
      angle = MathUtils.clamp(angle + MathUtils.radToDeg(d), -MAX, MAX)
      const st = ev.shiftKey ? 15 : 1
      let v = Math.round(angle / st) * st
      if (v === 0) v = angle < 0 ? -st : st
      useAngleManip.getState().onChange?.(+v.toFixed(3))
      invalidate()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!m.active) return null
  const color = hot ? colors.sel : '#e8b84a'
  return (
    <group matrixAutoUpdate={false} matrix={frame}>
      <Line points={arc} color={color} lineWidth={2} depthTest={false} transparent renderOrder={30} raycast={() => null} />
      <group position={[Math.cos(end) * m.radius, Math.sin(end) * m.radius, 0]}>
        <group ref={knob}>
          <mesh renderOrder={30}>
            <sphereGeometry args={[0.2, 16, 12]} />
            <meshBasicMaterial color={color} depthTest={false} transparent />
          </mesh>
          {/* generous hit area */}
          <mesh
            userData={{ handle: true }}
            onPointerDown={onDown as never}
            onPointerOver={() => { setHot(true); gl.domElement.style.cursor = 'grab' }}
            onPointerOut={() => { setHot(false); gl.domElement.style.cursor = '' }}
          >
            <sphereGeometry args={coarse ? [0.9, 12, 8] : [0.4, 12, 8]} />
            <meshBasicMaterial visible={false} />
          </mesh>
        </group>
        <Html position={[0, 0, 0]} zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
          {typing === null ? (
            <Tip label="Type a value" desc="Click to type an exact angle, then press Enter to accept it." side="top">
              <div className="sk-tip" data-testid="manip-value" style={{ transform: 'translate(14px, -26px)', pointerEvents: 'auto', cursor: 'text' }}
                onClick={() => setTyping(String(+m.angle.toFixed(3)))}>{`${m.angle.toFixed(1)} deg`}</div>
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
