/**
 * Touch navigation for the viewport (pointer events with pointerType "touch"):
 *
 *  - one finger drags to orbit about the point under it (the same turntable as the mouse, with inertia when it is on in Settings);
 *  - two fingers pan and pinch together: the point between them stays between them, and the zoom goes toward it;
 *  - a quick tap selects (a small slop is allowed, a finger is never still), a double tap fits everything;
 *  - a finger that went down on a handle (extrude arrow, move gizmo) or in a tool that owns one finger (sketching, painting) is
 *    left alone, and a second finger always makes it a camera gesture.
 *
 * The camera maths is the same pure poses as NavControls (orbitPose / zoomPose); this file only turns fingers into calls.
 */
import { MathUtils, Vector3 } from 'three'
import { navClock } from './navClock'
import { useNavSettings } from './navSettings'
import { fingerOwned, TAP_MS, TAP_SLOP, touchGrab } from './touchGrab'
import { useUi } from '@/store/ui'
import type { NavPose } from './NavControls'

export interface TouchCtx {
  el: HTMLElement
  pose: () => NavPose
  fov: number
  ortho: () => boolean
  radius: () => number
  cancelMotion: () => void
  /** surface under the finger, else the scene centre (what a mouse orbit turns about) */
  pivotAt: (e: { clientX: number; clientY: number }) => Vector3
  /** surface under the finger, else the point on the view-centre plane (what a zoom goes toward) */
  pivotAtView: (e: { clientX: number; clientY: number }) => Vector3
  orbit: (dx: number, dy: number, pivot: Vector3) => void
  setPivot: (p: Vector3 | null, on: boolean) => void
  startGlide: (vx: number, vy: number, pivot: Vector3) => void
  frame: () => void
  invalidate: () => void
  /** scale the view about a pivot (< 1 zooms in) */
  zoomPose: (p: NavPose, k: number, pivot: Vector3) => NavPose
}

interface Ptr { id: number; x: number; y: number; x0: number; y0: number; t0: number }

/** Point where the ray through client pixel (cx, cy) meets the plane through `pivot` that faces the camera, for any pose. */
function hitPlane(ctx: TouchCtx, pose: NavPose, cx: number, cy: number, pivot: Vector3): Vector3 {
  const r = ctx.el.getBoundingClientRect()
  const nx = ((cx - r.left) / r.width) * 2 - 1
  const ny = -((cy - r.top) / r.height) * 2 + 1
  const back = new Vector3(0, 0, 1).applyQuaternion(pose.q)
  const right = new Vector3(1, 0, 0).applyQuaternion(pose.q)
  const up = new Vector3(0, 1, 0).applyQuaternion(pose.q)
  const pos = pose.target.clone().addScaledVector(back, pose.dist)
  const th = Math.tan(MathUtils.degToRad(ctx.fov) / 2)
  const aspect = r.width / Math.max(1, r.height)
  let o = pos
  let d: Vector3
  if (ctx.ortho()) {
    o = pos.clone().addScaledVector(right, nx * pose.dist * th * aspect).addScaledVector(up, ny * pose.dist * th)
    d = back.clone().negate()
  } else {
    d = right.clone().multiplyScalar(nx * th * aspect).addScaledVector(up, ny * th).addScaledVector(back, -1).normalize()
  }
  const dn = d.dot(back)
  if (Math.abs(dn) < 1e-6) return pivot.clone()
  const t = pivot.clone().sub(o).dot(back) / dn
  return o.clone().addScaledVector(d, t)
}

/** Wire the touch gestures onto the canvas. Returns the function that takes them off again. */
export function installTouchNav(ctx: TouchCtx): () => void {
  const { el } = ctx
  const ptrs = new Map<number, Ptr>()
  let mode: 'none' | 'pending' | 'orbit' | 'multi' | 'ignore' = 'none'
  let orbitS: { pivot: Vector3; lx: number; ly: number; vx: number; vy: number; t: number; moved: number } | null = null
  let multi: { a: number; b: number; pose0: NavPose; P: Vector3; mx: number; my: number; d0: number } | null = null
  let tap: { id: number; x: number; y: number; t0: number } | null = null
  let lastTap: { t: number; x: number; y: number } | null = null
  let clickFix: { x: number; y: number; until: number } | null = null
  let clickTimer: ReturnType<typeof setTimeout> | undefined

  const pair = (): [Ptr, Ptr] | null => {
    const l = [...ptrs.values()]
    return l.length >= 2 ? [l[0], l[1]] : null
  }
  const endOrbit = (glide: boolean) => {
    const o = orbitS
    orbitS = null
    if (!o) return
    ctx.setPivot(o.pivot, false)
    // optional inertia: keep turning with the release velocity
    if (glide && useNavSettings.getState().inertia && navClock.now() - o.t < 90 && o.moved > 6) ctx.startGlide(o.vx, o.vy, o.pivot)
  }
  const startMulti = () => {
    const pr = pair()
    if (!pr) return
    const [a, b] = pr
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    const pose = ctx.pose()
    multi = {
      a: a.id, b: b.id, mx, my,
      d0: Math.max(24, Math.hypot(a.x - b.x, a.y - b.y)),
      pose0: { target: pose.target.clone(), q: pose.q.clone(), dist: pose.dist },
      P: ctx.pivotAtView({ clientX: mx, clientY: my }),
    }
    ctx.cancelMotion()
    mode = 'multi'
  }
  const stepMulti = () => {
    const m = multi
    if (!m) return
    const a = ptrs.get(m.a), b = ptrs.get(m.b)
    if (!a || !b) return
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    const d = Math.max(24, Math.hypot(a.x - b.x, a.y - b.y))
    // fingers apart (d grows) = zoom in = a smaller view distance; limits as for the wheel
    const R = ctx.radius()
    const dMin = Math.max(0.5, R * 0.003), dMax = R * 80 + 2000
    const cam0 = m.pose0.target.clone().addScaledVector(new Vector3(0, 0, 1).applyQuaternion(m.pose0.q), m.pose0.dist)
    const toPivot = cam0.distanceTo(m.P)
    const minApproach = Math.max(0.2, R * 0.0015)
    let k = m.d0 / d
    k = Math.max(k, minApproach / Math.max(toPivot, 1e-9), dMin / m.pose0.dist)
    k = Math.min(k, dMax / m.pose0.dist)
    const z = ctx.zoomPose(m.pose0, k, m.P)
    // then slide the view so the point that was between the fingers is between them now
    const w = hitPlane(ctx, z, mx, my, m.P)
    z.target.add(m.P.clone().sub(w))
    // (the pose of the camera is edited in place so the NavControls frame loop sees it)
    const live = ctx.pose()
    live.target.copy(z.target)
    live.dist = z.dist
    ctx.invalidate()
  }

  const down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    ptrs.set(e.pointerId, { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() })
    ctx.cancelMotion()
    if (ptrs.size === 1) {
      mode = 'pending'
      tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t0: performance.now() }
    } else {
      tap = null
      endOrbit(false)
      startMulti()
    }
  }

  const move = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    const p = ptrs.get(e.pointerId)
    if (!p) return
    p.x = e.clientX; p.y = e.clientY
    if (mode === 'pending' && ptrs.size === 1) {
      if (Math.hypot(p.x - p.x0, p.y - p.y0) <= TAP_SLOP) return
      tap = null
      // the finger went down on a handle, or in a tool that works with one finger: it is not the camera's
      if (touchGrab.stamp >= p.t0 || fingerOwned()) { mode = 'ignore'; return }
      mode = 'orbit'
      const pivot = ctx.pivotAt({ clientX: p.x0, clientY: p.y0 })
      orbitS = { pivot, lx: p.x, ly: p.y, vx: 0, vy: 0, t: navClock.now(), moved: 0 }
      ctx.setPivot(pivot, true)
      return
    }
    if (mode === 'orbit' && orbitS) {
      const o = orbitS
      const dx = p.x - o.lx, dy = p.y - o.ly
      const now = navClock.now()
      const dt = Math.max(1, now - o.t) / 1000
      o.vx = 0.6 * o.vx + 0.4 * (dx / dt)
      o.vy = 0.6 * o.vy + 0.4 * (dy / dt)
      o.moved += Math.abs(dx) + Math.abs(dy)
      o.lx = p.x; o.ly = p.y; o.t = now
      ctx.orbit(dx, dy, o.pivot)
      return
    }
    if (mode === 'multi') stepMulti()
  }

  const fireClick = () => {
    clearTimeout(clickTimer)
    const c = clickFix
    clickFix = null
    if (!c) return
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, clientX: c.x, clientY: c.y, button: 0, detail: 1 }))
  }

  const up = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    const p = ptrs.get(e.pointerId)
    if (!p) return
    p.x = e.clientX; p.y = e.clientY
    const wasTap = mode === 'pending' && ptrs.size === 1 && !!tap && tap.id === e.pointerId && e.type === 'pointerup' && performance.now() - tap.t0 <= TAP_MS && Math.hypot(p.x - p.x0, p.y - p.y0) <= TAP_SLOP
    if (mode === 'orbit') endOrbit(e.type === 'pointerup')
    ptrs.delete(e.pointerId)
    if (ptrs.size === 0) { mode = 'none'; multi = null; tap = null } else if (mode === 'multi') {
      // one of the two fingers lifted: with a third still down the pair is rebuilt from the rest, else the camera is done until all are up
      if (ptrs.size >= 2) startMulti()
      else { mode = 'ignore'; multi = null }
    }
    useUi.getState().setHover(null)
    if (!wasTap || fingerOwned()) return
    const now = performance.now()
    // double tap: fit everything
    if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x0 - lastTap.x, p.y0 - lastTap.y) < 32) {
      lastTap = null
      ctx.frame()
    } else lastTap = { t: now, x: p.x0, y: p.y0 }
    // the select click: the browser's own click may have moved a few pixels (the scene wants none), so it is replayed at the press point
    clickFix = { x: p.x0, y: p.y0, until: now + 500 }
    clearTimeout(clickTimer)
    clickTimer = setTimeout(fireClick, 90)
  }

  const click = (e: MouseEvent) => {
    if (!e.isTrusted || !clickFix || performance.now() > clickFix.until) return
    e.stopImmediatePropagation()
    e.preventDefault()
    fireClick()
  }

  el.addEventListener('pointerdown', down, true)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener('click', click, true)
  return () => {
    clearTimeout(clickTimer)
    el.removeEventListener('pointerdown', down, true)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    el.removeEventListener('click', click, true)
  }
}

