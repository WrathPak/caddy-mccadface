import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Box3, MathUtils, Matrix4, OrthographicCamera, PerspectiveCamera, Plane, Quaternion, Raycaster, Sphere, Vector2, Vector3 } from 'three'
import { viewportBus, type StepKind, type ViewDir } from './bus'

export const FOV = 40
const Z = new Vector3(0, 0, 1)
const AX = new Vector3(1, 0, 0)
const AY = new Vector3(0, 1, 0)
const AZ = new Vector3(0, 0, 1)

/** Unit vector from the target towards the camera for an azimuth / elevation (Z up). */
const dirOf = (az: number, el: number) => new Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el))
const HOME_DIR = dirOf(-Math.PI / 4, MathUtils.degToRad(32))

const DIRS: Record<ViewDir, Vector3> = {
  home: HOME_DIR,
  front: new Vector3(0, -1, 0),
  back: new Vector3(0, 1, 0),
  right: new Vector3(1, 0, 0),
  left: new Vector3(-1, 0, 0),
  top: new Vector3(0, 0, 1),
  bottom: new Vector3(0, 0, -1),
}

/**
 * Camera orientation looking at the target from direction `dir` (target -> camera), upright (world Z up). Looking straight
 * down / up uses +Y / -Y as the screen-up direction, so Top shows X to the right and Y up.
 */
export function lookQuat(dir: Vector3): Quaternion {
  const d = dir.clone().normalize()
  const up = Math.abs(d.z) > 0.9999 ? new Vector3(0, d.z > 0 ? 1 : -1, 0) : Z
  return new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(d, new Vector3(), up))
}

/** Local rotation (about the camera's own axes): X = pitch, Y = turn about the screen-vertical axis, Z = roll. */
const STEPS: Record<StepKind, [Vector3, number]> = {
  left: [AY, -Math.PI / 2],
  right: [AY, Math.PI / 2],
  up: [AX, -Math.PI / 2],
  down: [AX, Math.PI / 2],
  rollCW: [AZ, Math.PI / 2],
  rollCCW: [AZ, -Math.PI / 2],
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

interface Anim { t0: number; ms: number; q0: Quaternion; q1: Quaternion; dist0: number; dist1: number; target0: Vector3; target1: Vector3 }

/**
 * Fusion-style navigation, Z-up: MMB = pan, Shift+MMB = orbit, wheel = zoom to cursor. The orientation is a quaternion, so the
 * ViewCube can snap to any face / edge / corner, step the view in 90 degree turns and roll it. Transitions are animated.
 * Works for both perspective and orthographic cameras (ortho zoom is derived from the same distance).
 */
export function NavControls() {
  const { gl, size, invalidate, scene } = useThree()
  const s = useRef({ target: new Vector3(0, 0, 10), q: lookQuat(HOME_DIR), dist: 190 })
  const anim = useRef<Anim | null>(null)
  const sizeRef = useRef(size)
  sizeRef.current = size

  useFrame((state) => {
    const st = s.current
    const a = anim.current
    if (a) {
      const t = Math.min(1, (performance.now() - a.t0) / a.ms)
      const e = ease(t)
      st.q.slerpQuaternions(a.q0, a.q1, e)
      st.dist = MathUtils.lerp(a.dist0, a.dist1, e)
      st.target.lerpVectors(a.target0, a.target1, e)
      if (t >= 1) anim.current = null
      invalidate()
    }
    const cam = state.camera
    const back = new Vector3(0, 0, 1).applyQuaternion(st.q)
    cam.position.copy(st.target).addScaledVector(back, st.dist)
    cam.quaternion.copy(st.q)
    cam.up.set(0, 1, 0).applyQuaternion(st.q)
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
    /** Animate towards a goal; unspecified parts stay as they are (or at the current goal, so repeated clicks accumulate). */
    const goTo = (g: { q?: Quaternion; dist?: number; target?: Vector3 }, ms = 380) => {
      const st = s.current
      const prev = anim.current
      anim.current = {
        t0: performance.now(), ms,
        q0: st.q.clone(), q1: g.q ?? prev?.q1.clone() ?? st.q.clone(),
        dist0: st.dist, dist1: g.dist ?? prev?.dist1 ?? st.dist,
        target0: st.target.clone(), target1: g.target ?? prev?.target1.clone() ?? st.target.clone(),
      }
      invalidate()
    }
    const frame = () => {
      // everything the user is looking at: the bodies plus the live hair / feature previews
      const box = new Box3()
      for (const name of ['bodies', 'hair-preview']) {
        const g = scene.getObjectByName(name)
        if (g && g.visible) box.union(new Box3().setFromObject(g))
      }
      const sph = box.isEmpty() ? new Sphere(new Vector3(0, 0, 0), 40) : box.getBoundingSphere(new Sphere())
      goTo({ dist: (Math.max(sph.radius, 1) / Math.sin(MathUtils.degToRad(FOV) / 2)) * 1.15, target: sph.center.clone() })
    }
    const goalQ = () => anim.current?.q1.clone() ?? s.current.q.clone()
    /** Trackball-free turntable orbit: dx turns about world Z, dy tilts about the camera's right axis. */
    const orbit = (dx: number, dy: number) => {
      const st = s.current
      anim.current = null
      const upside = new Vector3(0, 1, 0).applyQuaternion(st.q).z < 0
      const yaw = new Quaternion().setFromAxisAngle(Z, -dx * 0.006 * (upside ? -1 : 1))
      const pitch = new Quaternion().setFromAxisAngle(AX, -dy * 0.006)
      st.q.premultiply(yaw).multiply(pitch).normalize()
      invalidate()
    }
    const offs = [
      viewportBus.on('frame', frame),
      viewportBus.on('view', (d) => goTo({ q: lookQuat(DIRS[d]) })),
      viewportBus.on('viewVec', ([x, y, z]) => goTo({ q: lookQuat(new Vector3(x, y, z)) })),
      viewportBus.on('step', (k) => {
        const [axis, ang] = STEPS[k]
        goTo({ q: goalQ().multiply(new Quaternion().setFromAxisAngle(axis, ang)).normalize() }, 320)
      }),
      viewportBus.on('orbit', ({ dx, dy }) => orbit(dx, dy)),
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
      anim.current = null
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!mode) return
      const st = s.current
      if (mode === 'orbit') orbit(e.movementX, e.movementY)
      else {
        const c = scene.userData.cam as PerspectiveCamera | OrthographicCamera | undefined
        if (!c) return
        const wpp = worldPerPixel(c)
        const right = new Vector3().setFromMatrixColumn(c.matrixWorld, 0)
        const up = new Vector3().setFromMatrixColumn(c.matrixWorld, 1)
        st.target.addScaledVector(right, -e.movementX * wpp).addScaledVector(up, e.movementY * wpp)
        invalidate()
      }
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
      anim.current = null
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
