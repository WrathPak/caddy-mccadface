import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Box3, MathUtils, Matrix4, Mesh, OrthographicCamera, PerspectiveCamera, Plane, Quaternion, Raycaster, Sphere, Vector2, Vector3 } from 'three'
import { navClock } from './navClock'
import { holdMotion } from './motion'
import { viewportBus, type StepKind, type ViewDir } from './bus'
import { dragAction, useNavSettings, wheelAction } from './navSettings'
import { DEBUG_HANDLE } from '@/app/flags'
import { installTouchNav } from './touchNav'
import { registerFingerOwner } from './touchGrab'
import { isCoarse } from '@/app/device'
import { useSketch } from '@/sketch/store'
import { useHairPaint } from '@/features/hair/paint'
import { useAssemblyRuntime } from '@/assembly/runtime'

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

/** Radians of turntable rotation per pixel of drag. */
const ORBIT_SPEED = 0.006
/** Highest elevation reachable by dragging: just short of the poles so the view never flips. */
const EL_MAX = MathUtils.degToRad(89.9)

export interface NavPose { target: Vector3; q: Quaternion; dist: number }

/** Turntable decomposition of an orientation: azimuth and elevation of the camera direction plus the roll about the view axis. */
export function turntableOf(q: Quaternion): { az: number; el: number; roll: number } {
  const back = new Vector3(0, 0, 1).applyQuaternion(q)
  const up = new Vector3(0, 1, 0).applyQuaternion(q)
  const el = Math.asin(MathUtils.clamp(back.z, -1, 1))
  // at a pole the horizontal heading is carried by the screen-up direction
  const az = Math.abs(back.z) > 0.9999 ? Math.atan2(-up.y * Math.sign(back.z), -up.x * Math.sign(back.z)) : Math.atan2(back.y, back.x)
  const level = lookQuat(dirOf(az, el))
  const rel = level.clone().invert().multiply(q)
  const roll = 2 * Math.atan2(rel.z, rel.w)
  return { az, el, roll: Math.atan2(Math.sin(roll), Math.cos(roll)) }
}

/** Orientation from azimuth / elevation / roll (the inverse of turntableOf). */
export function fromTurntable(az: number, el: number, roll: number): Quaternion {
  const q = lookQuat(dirOf(az, el))
  return roll ? q.multiply(new Quaternion().setFromAxisAngle(AZ, roll)) : q
}

/**
 * Orbit by a pointer delta (pixels), turntable style about world Z, rigidly about `pivot` so the pivot keeps its screen
 * position. The elevation is clamped just short of the poles. Pure: returns the new pose.
 */
export function orbitPose(p: NavPose, dx: number, dy: number, pivot: Vector3, speed = 1): NavPose {
  const { az, el, roll } = turntableOf(p.q)
  const flip = Math.cos(roll) < 0 ? -1 : 1 // an upside-down view mirrors the drag
  const az2 = az - dx * ORBIT_SPEED * speed * flip
  const el2 = MathUtils.clamp(el + dy * ORBIT_SPEED * speed * flip, -EL_MAX, EL_MAX)
  const q2 = fromTurntable(az2, el2, roll)
  const delta = q2.clone().multiply(p.q.clone().invert())
  const back0 = new Vector3(0, 0, 1).applyQuaternion(p.q)
  const cam0 = p.target.clone().addScaledVector(back0, p.dist)
  const cam1 = pivot.clone().add(cam0.sub(pivot).applyQuaternion(delta))
  const back1 = new Vector3(0, 0, 1).applyQuaternion(q2)
  return { q: q2, dist: p.dist, target: cam1.addScaledVector(back1, -p.dist) }
}

/** Scale the view about `pivot` by k (< 1 zooms in): the pivot keeps its screen position. */
export function zoomPose(p: NavPose, k: number, pivot: Vector3): NavPose {
  return { q: p.q, dist: p.dist * k, target: pivot.clone().add(p.target.clone().sub(pivot).multiplyScalar(k)) }
}

interface Anim { t0: number; ms: number; q0: Quaternion; q1: Quaternion; dist0: number; dist1: number; target0: Vector3; target1: Vector3 }

/** Everything the user is looking at: the bodies plus the live hair / feature previews. */
function sceneBox(scene: { getObjectByName(n: string): { visible: boolean } | undefined }): Box3 {
  const box = new Box3()
  for (const name of ['bodies', 'hair-preview']) {
    const g = scene.getObjectByName(name)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (g && g.visible) box.union(new Box3().setFromObject(g as any))
  }
  return box
}

/** Live camera state for the tests and the pivot marker. */
export const navDebug: { pose: NavPose | null; pivot: Vector3 | null; bounds: Box3 | null } = { pose: null, pivot: null, bounds: null }

/**
 * Professional navigation, Z up. The orientation is a quaternion so the ViewCube can snap to any face / edge / corner, step in 90 degree
 * turns and roll; transitions are animated.
 *
 *  - Orbit is a turntable about the point under the cursor (raycast on the bodies at the drag start, else the scene centre), clamped
 *    at the poles, and rigid about that pivot so it stays put on screen. A small marker shows the pivot while orbiting.
 *  - Pan keeps the grabbed point exactly under the cursor (screen to world on the plane through the pivot).
 *  - The wheel zooms towards the cursor with a smooth exponential step, in perspective and orthographic alike. Near / far follow the
 *    scene so the view never clips into the model.
 *  - Trackpad: pinch zooms, two-finger scroll pans, Shift + two-finger scroll orbits. Middle double-click fits all.
 *  - The button gestures follow the chosen preset (Settings); optional inertia.
 */
/** The view as it was when the viewport last went away (the phone layout and the dock swap the viewport out when the screen turns). */
let savedPose: NavPose | null = null

export function NavControls() {
  const { gl, size, invalidate, scene } = useThree()
  const s = useRef<NavPose>(savedPose ? { target: savedPose.target.clone(), q: savedPose.q.clone(), dist: savedPose.dist } : { target: new Vector3(0, 0, 10), q: lookQuat(HOME_DIR), dist: 190 })
  useEffect(() => registerFingerOwner(() => useSketch.getState().active || useHairPaint.getState().mode !== 'off' || useAssemblyRuntime.getState().tool === 'drag'), [])
  useEffect(() => () => { savedPose = { target: s.current.target.clone(), q: s.current.q.clone(), dist: s.current.dist } }, [])
  const anim = useRef<Anim | null>(null)
  const sizeRef = useRef(size)
  sizeRef.current = size
  /** smooth wheel zoom: remaining log-scale to apply about the pivot */
  const zoom = useRef<{ log: number; pivot: Vector3; last: number } | null>(null)
  /** inertia after a drag: orbit pixels / s or pan world units / s */
  const glide = useRef<{ kind: 'orbit' | 'pan'; vx: number; vy: number; pivot: Vector3; world?: Vector3 } | null>(null)
  const marker = useRef<{ el: HTMLDivElement; until: number; on: boolean } | null>(null)
  const boundsCache = useRef<{ box: Box3; at: number }>({ box: new Box3(), at: -1 })

  const getBounds = (state: { scene: Parameters<typeof sceneBox>[0] }) => {
    const c = boundsCache.current
    const now = navClock.now()
    if (now - c.at > 120) { c.box = sceneBox(state.scene); c.at = now }
    return c.box
  }

  const lastFrame = useRef<number | null>(null)
  useFrame((state, realDt) => {
    // frame time comes from the nav clock so specs can freeze and step it (it equals the real frame delta otherwise)
    const frameNow = navClock.now()
    const dt = lastFrame.current === null ? realDt : Math.max(0, (frameNow - lastFrame.current) / 1000)
    lastFrame.current = frameNow
    const st = s.current
    const cam = state.camera
    const a = anim.current
    if (a) {
      const t = Math.min(1, (navClock.now() - a.t0) / a.ms)
      const e = ease(t)
      st.q.slerpQuaternions(a.q0, a.q1, e)
      st.dist = MathUtils.lerp(a.dist0, a.dist1, e)
      st.target.lerpVectors(a.target0, a.target1, e)
      if (t >= 1) anim.current = null
      invalidate()
    }
    const box = getBounds(state)
    const sph = box.isEmpty() ? new Sphere(new Vector3(0, 0, 10), 60) : box.getBoundingSphere(new Sphere())
    const R = Math.max(sph.radius, 1)

    // smooth exponential wheel zoom, about the pivot under the cursor
    const z = zoom.current
    if (z && Math.abs(z.log) > 1e-5) {
      const step = Math.abs(z.log) < 2e-3 ? z.log : z.log * (1 - Math.exp(-Math.min(dt, 0.1) / 0.06))
      z.log -= step
      applyZoom(Math.exp(step), z.pivot, R)
      invalidate()
    }
    // inertia
    const g = glide.current
    if (g) {
      const decay = Math.exp(-Math.min(dt, 0.1) / 0.14)
      g.vx *= decay; g.vy *= decay
      if (g.kind === 'orbit') {
        Object.assign(st, orbitPose(st, g.vx * dt, g.vy * dt, g.pivot, useNavSettings.getState().orbitSpeed))
      } else if (g.world) {
        g.world.multiplyScalar(decay)
        st.target.addScaledVector(g.world, dt)
      }
      if (Math.hypot(g.vx, g.vy) < 4 && (!g.world || g.world.length() < 1e-3)) glide.current = null
      invalidate()
    }

    const back = new Vector3(0, 0, 1).applyQuaternion(st.q)
    cam.position.copy(st.target).addScaledVector(back, st.dist)
    cam.quaternion.copy(st.q)
    cam.up.set(0, 1, 0).applyQuaternion(st.q)
    // near / far follow the scene: everything lies within [d - R, d + R] of the camera; the near plane never reaches the geometry
    const dc = cam.position.distanceTo(sph.center)
    const floor = Math.max(0.01, R * 4e-4)
    // the extra reach (8x the orbit distance) is for the ground grid, which fades out well inside it instead of hitting the clip plane
    const far = dc + R * 1.25 + 10 + st.dist * 8
    if ((cam as OrthographicCamera).isOrthographicCamera) {
      const o = cam as OrthographicCamera
      o.zoom = sizeRef.current.height / (2 * st.dist * Math.tan(MathUtils.degToRad(FOV) / 2))
      o.near = -(dc + R * 2 + 10)
      o.far = far
      o.updateProjectionMatrix()
    } else {
      const p = cam as PerspectiveCamera
      p.near = dc > R * 1.05 ? Math.max(floor, Math.min((dc - R) * 0.5, dc * 0.05)) : floor // capped so a grazing view of the ground is not cut off by the near plane
      p.far = far
      p.updateProjectionMatrix()
    }
    cam.updateMatrixWorld()
    // a fingertip covers a few millimetres of screen: edges and points are picked from further away (world units, so it follows the zoom)
    if (isCoarse()) {
      const wpp = (cam as OrthographicCamera).isOrthographicCamera ? 1 / (cam as OrthographicCamera).zoom : (2 * st.dist * Math.tan(MathUtils.degToRad(FOV) / 2)) / state.size.height
      const params = state.raycaster.params
      if (params.Line) params.Line.threshold = Math.max(1.2, wpp * 13)
      if (params.Points) params.Points.threshold = Math.max(1, wpp * 15)
    }
    state.scene.userData.cam = cam
    navDebug.pose = st
    navDebug.bounds = box

    // pivot marker
    const m = marker.current
    if (m) {
      const visible = m.on || navClock.now() < m.until
      if (visible && navDebug.pivot) {
        const p = navDebug.pivot.clone().project(cam)
        const w = sizeRef.current.width, h = sizeRef.current.height
        m.el.style.display = 'block'
        m.el.style.left = `${((p.x + 1) / 2) * w}px`
        m.el.style.top = `${((1 - p.y) / 2) * h}px`
        m.el.style.opacity = m.on ? '1' : String(Math.max(0, (m.until - navClock.now()) / 450))
        if (!m.on) invalidate()
      } else m.el.style.display = 'none'
    }

    /** Dolly / scale about a pivot with limits that keep the camera out of the model. */
    function applyZoom(k0: number, pivot: Vector3, radius: number) {
      const c = st.target.clone().addScaledVector(new Vector3(0, 0, 1).applyQuaternion(st.q), st.dist)
      const toPivot = c.distanceTo(pivot)
      const minApproach = Math.max(0.2, radius * 0.0015)
      const dMin = Math.max(0.5, radius * 0.003), dMax = radius * 80 + 2000
      let k = k0
      if (k < 1) k = Math.max(k, minApproach / Math.max(toPivot, 1e-9), dMin / st.dist)
      else k = Math.min(k, dMax / st.dist)
      if (k0 < 1 && toPivot <= minApproach * 1.001) k = Math.max(k, 1) // already as close as allowed
      Object.assign(st, zoomPose(st, k, pivot))
    }
  })

  useEffect(() => {
    const el = gl.domElement
    const ray = new Raycaster()
    const host = el.parentElement
    // pivot marker
    let mk: { el: HTMLDivElement; until: number; on: boolean } | null = null
    if (host) {
      const d = document.createElement('div')
      d.className = 'nav-pivot'
      d.setAttribute('data-testid', 'nav-pivot')
      d.style.display = 'none'
      host.appendChild(d)
      mk = { el: d, until: 0, on: false }
      marker.current = mk
    }

    const cameraOf = () => (scene.userData.cam as PerspectiveCamera | OrthographicCamera | undefined)
    const ndcOf = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    }
    /** First body surface under the cursor, else the centre of the scene. */
    const pivotAt = (e: { clientX: number; clientY: number }): Vector3 => {
      const c = cameraOf()
      const st = s.current
      if (c) {
        const bodies = scene.getObjectByName('bodies')
        if (bodies) {
          ray.setFromCamera(ndcOf(e), c)
          ray.firstHitOnly = true
          const hits = ray.intersectObject(bodies, true).filter((h) => (h.object as Mesh).isMesh && h.object.visible)
          if (hits.length) return hits[0].point.clone()
        }
      }
      const box = sceneBox(scene)
      return box.isEmpty() ? st.target.clone() : box.getCenter(new Vector3())
    }
    /** Point under the cursor on the plane through `pivot` facing the camera. */
    const onPlane = (c: PerspectiveCamera | OrthographicCamera, e: { clientX: number; clientY: number }, pivot: Vector3) => {
      ray.setFromCamera(ndcOf(e), c)
      const n = new Vector3()
      c.getWorldDirection(n)
      const hit = new Vector3()
      return ray.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(n, pivot), hit) ? hit : null
    }
    const worldPerPixel = (c: PerspectiveCamera | OrthographicCamera) =>
      (c as OrthographicCamera).isOrthographicCamera
        ? 1 / (c as OrthographicCamera).zoom
        : (2 * s.current.dist * Math.tan(MathUtils.degToRad(FOV) / 2)) / sizeRef.current.height

    /** Animate towards a goal; unspecified parts stay as they are (or at the current goal, so repeated clicks accumulate). */
    const goTo = (g: { q?: Quaternion; dist?: number; target?: Vector3 }, ms = 380) => {
      const st = s.current
      const prev = anim.current
      zoom.current = null
      glide.current = null
      anim.current = {
        t0: navClock.now(), ms,
        q0: st.q.clone(), q1: g.q ?? prev?.q1.clone() ?? st.q.clone(),
        dist0: st.dist, dist1: g.dist ?? prev?.dist1 ?? st.dist,
        target0: st.target.clone(), target1: g.target ?? prev?.target1.clone() ?? st.target.clone(),
      }
      invalidate()
    }
    const fitSphere = (center: Vector3, radius: number) =>
      goTo({ dist: (Math.max(radius, 0.5) / Math.sin(MathUtils.degToRad(FOV) / 2)) * 1.15, target: center })
    const frame = () => {
      const box = sceneBox(scene)
      if (box.isEmpty()) return fitSphere(new Vector3(0, 0, 0), 40)
      const sph = box.getBoundingSphere(new Sphere())
      fitSphere(sph.center.clone(), sph.radius)
    }
    const goalQ = () => anim.current?.q1.clone() ?? s.current.q.clone()
    const setPivot = (p: Vector3 | null, on: boolean) => {
      navDebug.pivot = p
      if (mk) { mk.on = on; if (!on) mk.until = navClock.now() + 450 }
      invalidate()
    }
    /** Orbit by a pixel delta about a pivot (default: the view centre). */
    const orbit = (dx: number, dy: number, pivot?: Vector3) => {
      anim.current = null
      glide.current = null
      Object.assign(s.current, orbitPose(s.current, dx, dy, pivot ?? s.current.target, useNavSettings.getState().orbitSpeed))
      invalidate()
    }
    const offs = [
      viewportBus.on('frame', frame),
      viewportBus.on('frameBox', ({ min, max }) => {
        const b = new Box3(new Vector3(...min), new Vector3(...max))
        const sph = b.getBoundingSphere(new Sphere())
        fitSphere(sph.center.clone(), sph.radius)
      }),
      viewportBus.on('view', (d) => goTo({ q: lookQuat(DIRS[d]) })),
      viewportBus.on('viewVec', ([x, y, z]) => goTo({ q: lookQuat(new Vector3(x, y, z)) })),
      viewportBus.on('tiltFromFacing', ({ normal, within = 10, deg = 30 }) => {
        const q = goalQ()
        const n = new Vector3(...normal).normalize()
        if (Math.abs(new Vector3(0, 0, 1).applyQuaternion(q).dot(n)) < Math.cos(MathUtils.degToRad(within))) return
        // pitch about the screen's horizontal axis, turn about its vertical one; of the four ways, the one that ends nearest the home view
        let best: Quaternion | null = null, bestScore = -Infinity
        for (const sy of [1, -1]) for (const sp of [1, -1]) {
          const q2 = q.clone()
            .multiply(new Quaternion().setFromAxisAngle(AY, MathUtils.degToRad(deg * 0.8) * sy))
            .multiply(new Quaternion().setFromAxisAngle(AX, MathUtils.degToRad(deg) * sp))
            .normalize()
          const score = new Vector3(0, 0, 1).applyQuaternion(q2).dot(HOME_DIR)
          if (score > bestScore + 1e-9) { best = q2; bestScore = score }
        }
        if (best) goTo({ q: best })
      }),
      viewportBus.on('step', (k) => {
        const [axis, ang] = STEPS[k]
        goTo({ q: goalQ().multiply(new Quaternion().setFromAxisAngle(axis, ang)).normalize() }, 320)
      }),
      viewportBus.on('orbit', ({ dx, dy }) => orbit(dx, dy)),
    ]

    // ---- pointer drags
    interface Drag {
      kind: 'orbit' | 'pan' | 'zoom'
      id: number
      pivot: Vector3
      x: number; y: number
      /** pan: camera at the start and the grabbed point */
      cam0?: PerspectiveCamera | OrthographicCamera
      grab?: Vector3
      target0?: Vector3
      /** velocity estimate (px / s) */
      vx: number; vy: number; t: number
      moved: number
    }
    let drag: Drag | null = null
    let release: (() => void) | null = null
    let lastMiddle = { t: 0, x: 0, y: 0, fit: false }

    const down = (e: PointerEvent) => {
      if (e.button === 1) e.preventDefault()
      const kind = dragAction(useNavSettings.getState().preset, e)
      if (!kind) return
      if (e.button === 0) e.stopPropagation()
      const c = cameraOf()
      if (!c) return
      e.preventDefault()
      // double-click of the middle button fits everything (a further click right after it is swallowed, it must not stop the fit)
      if (e.button === 1) {
        const now = navClock.now()
        if (now - lastMiddle.t < 350 && Math.hypot(e.clientX - lastMiddle.x, e.clientY - lastMiddle.y) < 6) {
          if (!lastMiddle.fit) frame()
          lastMiddle = { t: now, x: e.clientX, y: e.clientY, fit: true }
          return
        }
        lastMiddle = { t: now, x: e.clientX, y: e.clientY, fit: false }
      }
      anim.current = null
      glide.current = null
      zoom.current = null
      const pivot = pivotAt(e)
      el.setPointerCapture(e.pointerId)
      drag = { kind, id: e.pointerId, pivot, x: e.clientX, y: e.clientY, vx: 0, vy: 0, t: navClock.now(), moved: 0 }
      release?.()
      release = holdMotion()
      if (kind === 'pan') {
        const cam0 = c.clone() as PerspectiveCamera | OrthographicCamera
        cam0.updateMatrixWorld()
        drag.cam0 = cam0
        drag.target0 = s.current.target.clone()
        drag.grab = onPlane(cam0, e, pivot) ?? pivot.clone()
      }
      if (kind === 'orbit') setPivot(pivot, true)
      invalidate()
    }
    const move = (e: PointerEvent) => {
      const d = drag
      if (!d || e.pointerId !== d.id) return
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      const now = navClock.now()
      const dt = Math.max(1, now - d.t) / 1000
      d.vx = 0.6 * d.vx + 0.4 * (dx / dt)
      d.vy = 0.6 * d.vy + 0.4 * (dy / dt)
      d.moved += Math.abs(dx) + Math.abs(dy)
      d.x = e.clientX; d.y = e.clientY; d.t = now
      if (d.kind === 'orbit') orbit(dx, dy, d.pivot)
      else if (d.kind === 'pan') {
        const w = onPlane(d.cam0!, e, d.pivot)
        if (w) {
          // the grabbed point follows the cursor exactly: shift the view by the world offset between where it is and where it should be
          s.current.target.copy(d.target0!).add(d.grab!.clone().sub(w))
          invalidate()
        }
      } else {
        // drag zoom: dragging down zooms in
        applyDragZoom(Math.exp(-dy * 0.01), d.pivot)
      }
    }
    const applyDragZoom = (k: number, pivot: Vector3) => {
      Object.assign(s.current, zoomPose(s.current, MathUtils.clamp(k, 0.2, 5), pivot))
      invalidate()
    }
    const up = (e: PointerEvent) => {
      const d = drag
      if (!d || e.pointerId !== d.id) return
      drag = null
      release?.()
      release = null
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      if (d.kind === 'orbit') setPivot(d.pivot, false)
      // optional inertia: keep going with the release velocity
      if (useNavSettings.getState().inertia && navClock.now() - d.t < 90 && d.moved > 6 && (d.kind === 'orbit' || d.kind === 'pan')) {
        if (d.kind === 'orbit') glide.current = { kind: 'orbit', vx: d.vx, vy: d.vy, pivot: d.pivot }
        else {
          const c = cameraOf()
          if (c) {
            const wpp = worldPerPixel(c)
            const right = new Vector3().setFromMatrixColumn(c.matrixWorld, 0)
            const upv = new Vector3().setFromMatrixColumn(c.matrixWorld, 1)
            glide.current = { kind: 'pan', vx: d.vx, vy: d.vy, pivot: d.pivot, world: right.multiplyScalar(-d.vx * wpp).addScaledVector(upv, d.vy * wpp) }
          }
        }
        invalidate()
      }
    }

    // ---- wheel / trackpad
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const c = cameraOf()
      if (!c) return
      anim.current = null
      glide.current = null
      // normalise line / page deltas to pixels
      const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      const dX = e.deltaX * px, dY = e.deltaY * px
      const act = wheelAction(useNavSettings.getState().preset, e)
      if (act === 'zoom') {
        const now = navClock.now()
        const z = zoom.current
        // one pivot per burst of events, so the point under the cursor stays under it
        const pivot = z && now - z.last < 180 ? z.pivot : (pivotAtWheel(e) ?? s.current.target)
        // pinch (ctrl) events carry small deltas: scale them up
        const dir = useNavSettings.getState().zoomDirection === 'reverse' ? -1 : 1
        const amount = dir * (e.ctrlKey ? MathUtils.clamp(dY, -40, 40) * 0.012 : MathUtils.clamp(dY, -240, 240) * 0.0015)
        zoom.current = { log: (z?.log ?? 0) + amount, pivot, last: now } // unspent zoom carries over into the next burst
      } else if (act === 'pan') {
        const wpp = worldPerPixel(c)
        const right = new Vector3().setFromMatrixColumn(c.matrixWorld, 0)
        const upv = new Vector3().setFromMatrixColumn(c.matrixWorld, 1)
        s.current.target.addScaledVector(right, dX * wpp).addScaledVector(upv, -dY * wpp)
      } else {
        const pivot = pivotAt(e)
        setPivot(pivot, false)
        orbit(-dX * 0.5, -dY * 0.5, pivot)
      }
      invalidate()
    }
    /** Zoom pivot: the surface under the cursor, else the point on the view-centre plane under the cursor. */
    const pivotAtWheel = (e: WheelEvent): Vector3 | null => {
      const c = cameraOf()
      if (!c) return null
      const bodies = scene.getObjectByName('bodies')
      if (bodies) {
        ray.setFromCamera(ndcOf(e), c)
        ray.firstHitOnly = true
        const hits = ray.intersectObject(bodies, true).filter((h) => (h.object as Mesh).isMesh && h.object.visible)
        if (hits.length) return hits[0].point.clone()
      }
      return onPlane(c, e, s.current.target)
    }

    const block = (e: MouseEvent) => e.button === 1 && e.preventDefault()
    el.addEventListener('pointerdown', down, true)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('auxclick', block)
    // fingers: orbit, pan, pinch, tap, double tap (touchNav.ts)
    const offTouch = installTouchNav({
      el, fov: FOV, zoomPose,
      pose: () => s.current,
      ortho: () => !!(cameraOf() as OrthographicCamera | undefined)?.isOrthographicCamera,
      radius: () => {
        const box = sceneBox(scene)
        return box.isEmpty() ? 60 : Math.max(box.getBoundingSphere(new Sphere()).radius, 1)
      },
      cancelMotion: () => { anim.current = null; glide.current = null; zoom.current = null },
      pivotAt,
      pivotAtView: (e) => pivotAtWheel(e as WheelEvent) ?? s.current.target.clone(),
      orbit,
      setPivot,
      startGlide: (vx, vy, pivot) => { glide.current = { kind: 'orbit', vx, vy, pivot }; invalidate() },
      frame,
      invalidate,
    })
    if (DEBUG_HANDLE) {
      ;(window as unknown as { __nav?: unknown }).__nav = {
        pose: () => ({ target: s.current.target.toArray(), dist: s.current.dist, q: s.current.q.toArray() }),
        pivot: () => navDebug.pivot?.toArray() ?? null,
        turntable: () => turntableOf(s.current.q),
        setPose: (p: { target?: number[]; dist?: number; q?: number[] }) => {
          if (p.target) s.current.target.fromArray(p.target)
          if (p.dist) s.current.dist = p.dist
          if (p.q) s.current.q.fromArray(p.q)
          invalidate()
        },
      }
    }
    return () => {
      offs.forEach((o) => o())
      offTouch()
      release?.()
      el.removeEventListener('pointerdown', down, true)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('auxclick', block)
      mk?.el.remove()
      marker.current = null
    }
  }, [gl, invalidate, scene])

  return null
}
