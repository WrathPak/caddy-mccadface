import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Box3, MathUtils, OrthographicCamera, PerspectiveCamera, Plane, Raycaster, Sphere, Vector2, Vector3 } from 'three'
import { viewportBus, type ViewDir } from './bus'

export const FOV = 40
const EL_MAX = MathUtils.degToRad(89)
const HOME = { az: -Math.PI / 4, el: MathUtils.degToRad(32) }
const PRESETS: Record<ViewDir, { az: number; el: number }> = {
  home: HOME,
  front: { az: -Math.PI / 2, el: 0 },
  back: { az: Math.PI / 2, el: 0 },
  right: { az: 0, el: 0 },
  left: { az: Math.PI, el: 0 },
  top: { az: -Math.PI / 2, el: EL_MAX },
  bottom: { az: -Math.PI / 2, el: -EL_MAX },
}

interface Goal { az: number; el: number; dist: number; target: Vector3 }

/**
 * Fusion-style navigation, Z-up: MMB = pan, Shift+MMB = orbit, wheel = zoom to cursor.
 * Works for both perspective and orthographic cameras (ortho zoom is derived from the same distance).
 */
export function NavControls() {
  const { gl, size, invalidate, scene } = useThree()
  const s = useRef({ target: new Vector3(0, 0, 10), az: HOME.az, el: HOME.el, dist: 190 })
  const goal = useRef<Goal | null>(null)
  const sizeRef = useRef(size)
  sizeRef.current = size

  useFrame((state) => {
    const st = s.current
    const g = goal.current
    if (g) {
      const k = 0.28
      let da = g.az - st.az
      da = Math.atan2(Math.sin(da), Math.cos(da))
      st.az += da * k
      st.el += (g.el - st.el) * k
      st.dist += (g.dist - st.dist) * k
      st.target.lerp(g.target, k)
      if (Math.abs(da) + Math.abs(g.el - st.el) + Math.abs(g.dist - st.dist) < 1e-3 && st.target.distanceTo(g.target) < 1e-3) goal.current = null
      invalidate()
    }
    const cam = state.camera
    const ce = Math.cos(st.el)
    cam.position.set(st.target.x + st.dist * ce * Math.cos(st.az), st.target.y + st.dist * ce * Math.sin(st.az), st.target.z + st.dist * Math.sin(st.el))
    cam.up.set(0, 0, 1)
    cam.lookAt(st.target)
    if ((cam as OrthographicCamera).isOrthographicCamera) {
      const o = cam as OrthographicCamera
      o.zoom = sizeRef.current.height / (2 * st.dist * Math.tan(MathUtils.degToRad(FOV) / 2))
      o.near = -st.dist * 50
      o.far = st.dist * 50
      o.updateProjectionMatrix()
    } else {
      const p = cam as PerspectiveCamera
      p.near = Math.max(0.05, st.dist * 0.01)
      p.far = st.dist * 30 + 300
      p.updateProjectionMatrix()
    }
    cam.updateMatrixWorld()
  })

  useEffect(() => {
    const el = gl.domElement
    const ray = new Raycaster()
    const frame = () => {
      const g = scene.getObjectByName('bodies')
      const box = g ? new Box3().setFromObject(g) : new Box3()
      const sph = box.isEmpty() ? new Sphere(new Vector3(0, 0, 0), 40) : box.getBoundingSphere(new Sphere())
      const g0 = goal.current ?? { az: s.current.az, el: s.current.el }
      goal.current = { az: g0.az, el: g0.el, dist: Math.max(sph.radius, 1) / Math.sin(MathUtils.degToRad(FOV) / 2) * 1.15, target: sph.center.clone() }
      invalidate()
    }
    const view = (p: { az: number; el: number }) => {
      goal.current = { az: p.az, el: p.el, dist: s.current.dist, target: s.current.target.clone() }
      invalidate()
    }
    const offs = [
      viewportBus.on('frame', frame),
      viewportBus.on('view', (d) => view(PRESETS[d])),
      viewportBus.on('viewVec', ([x, y, z]) => view({ az: Math.atan2(y, x), el: MathUtils.clamp(Math.asin(z), -EL_MAX, EL_MAX) })),
    ]

    let mode: 'pan' | 'orbit' | null = null
    const worldPerPixel = (cam: PerspectiveCamera | OrthographicCamera) =>
      (cam as OrthographicCamera).isOrthographicCamera
        ? 1 / (cam as OrthographicCamera).zoom
        : (2 * s.current.dist * Math.tan(MathUtils.degToRad(FOV) / 2)) / sizeRef.current.height

    const down = (e: PointerEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      mode = e.shiftKey ? 'orbit' : 'pan'
      goal.current = null
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!mode) return
      const st = s.current
      if (mode === 'orbit') {
        st.az -= e.movementX * 0.006
        st.el = MathUtils.clamp(st.el + e.movementY * 0.006, -EL_MAX, EL_MAX)
      } else {
        const c = scene.userData.cam as PerspectiveCamera | OrthographicCamera | undefined
        if (!c) return
        const wpp = worldPerPixel(c)
        const right = new Vector3().setFromMatrixColumn(c.matrixWorld, 0)
        const up = new Vector3().setFromMatrixColumn(c.matrixWorld, 1)
        st.target.addScaledVector(right, -e.movementX * wpp).addScaledVector(up, e.movementY * wpp)
      }
      invalidate()
    }
    const up = (e: PointerEvent) => {
      if (e.button === 1) {
        mode = null
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      }
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const c = scene.userData.cam as PerspectiveCamera | OrthographicCamera | undefined
      if (!c) return
      const st = s.current
      goal.current = null
      const f = Math.exp(MathUtils.clamp(e.deltaY, -200, 200) * 0.0015)
      const nd = MathUtils.clamp(st.dist * f, 0.5, 50000)
      const k = nd / st.dist
      const r = el.getBoundingClientRect()
      const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, c)
      const nrm = new Vector3()
      c.getWorldDirection(nrm)
      const hit = new Vector3()
      if (ray.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(nrm, st.target), hit)) {
        st.target.addScaledVector(hit.sub(st.target), 1 - k)
      }
      st.dist = nd
      invalidate()
    }
    const block = (e: MouseEvent) => e.button === 1 && e.preventDefault()
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('auxclick', block)
    return () => {
      offs.forEach((o) => o())
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('auxclick', block)
    }
  }, [gl, invalidate, scene])

  // expose the active camera to the handlers above
  useFrame((state) => {
    state.scene.userData.cam = state.camera
  })
  return null
}
