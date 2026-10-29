import { useEffect, useState, type RefObject } from 'react'
import { getCommand, runCommand } from '@/app/commands'
import { fingerOwned, LONG_PRESS_MS, TAP_SLOP, touchCount } from '@/viewport/touchGrab'
import { useSketch } from '@/sketch/store'

/** Eight slots clockwise from top. */
const SLOTS = ['solid.extrude', 'solid.fillet', 'sketch.create', 'solid.move', 'inspect.measure', 'view.frame', 'edit.delete', 'app.palette']
/** Short labels so the eight items fit around the ring without overlapping. */
const SHORT: Record<string, string> = { 'sketch.create': 'Sketch', 'view.frame': 'Frame', 'app.palette': 'Search', 'solid.move': 'Move', 'edit.delete': 'Delete' }
/** Ellipse the items sit on: wide enough that neighbouring pills (74 x 24 px) never touch. */
const RX = 118
const RY = 92
const DEAD = 22

/** Keep the whole ring on screen: a long press near an edge opens the menu a little inward. */
function clampToScreen(x: number, y: number) {
  const w = window.innerWidth, h = window.innerHeight
  return { x: Math.min(Math.max(x, RX + 48), Math.max(RX + 48, w - RX - 48)), y: Math.min(Math.max(y, RY + 22), Math.max(RY + 22, h - RY - 70)) }
}

/** Radial right-click menu. Hold + drag + release to pick, or tap and click an item. */
export function MarkingMenu({ target }: { target: RefObject<HTMLElement | null> }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [hot, setHot] = useState<number | null>(null)

  useEffect(() => {
    const el = target.current
    if (!el) return
    let down: { x: number; y: number; t: number } | null = null
    const slotAt = (x: number, y: number, c: { x: number; y: number }) => {
      const dx = x - c.x
      const dy = y - c.y
      if (Math.hypot(dx, dy) < DEAD) return null
      const a = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2)
      return Math.round(a / (Math.PI / 4)) % 8
    }
    // a finger resting on the viewport opens the menu, like a right click (the sketcher and handles keep their own long press)
    let press: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null
    const cancelPress = () => { if (press) clearTimeout(press.timer); press = null }
    const touchDown = (e: PointerEvent) => {
      cancelPress()
      if ((e.target as HTMLElement).tagName !== 'CANVAS' || touchCount() > 1 || useSketch.getState().active || fingerOwned()) return
      const p = { id: e.pointerId, x: e.clientX, y: e.clientY }
      press = { ...p, timer: setTimeout(() => {
        if (!press || touchCount() !== 1) return
        press = null
        setPos(clampToScreen(p.x, p.y))
        setHot(null)
      }, LONG_PRESS_MS) }
    }
    const touchMove = (e: PointerEvent) => {
      if (press && (touchCount() > 1 || Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP)) cancelPress()
    }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return touchDown(e)
      if (e.button !== 2) return
      down = { x: e.clientX, y: e.clientY, t: performance.now() }
      setPos({ x: e.clientX, y: e.clientY })
      setHot(null)
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return touchMove(e)
      if (down) setHot(slotAt(e.clientX, e.clientY, down))
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return cancelPress()
      if (!down || e.button !== 2) return
      const s = slotAt(e.clientX, e.clientY, down)
      const c = down
      down = null
      if (s !== null) {
        runCommand(SLOTS[s])
        setPos(null)
      } else if (performance.now() - c.t > 350) setPos(null)
      // quick tap leaves the menu open for click selection
    }
    const ctx = (e: Event) => e.preventDefault()
    el.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    el.addEventListener('contextmenu', ctx)
    window.addEventListener('pointercancel', cancelPress)
    return () => {
      cancelPress()
      window.removeEventListener('pointercancel', cancelPress)
      el.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      el.removeEventListener('contextmenu', ctx)
    }
  }, [target])

  useEffect(() => {
    if (!pos) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setPos(null)
    const away = (e: PointerEvent) => {
      if (e.button === 0 && !(e.target as HTMLElement).closest('.marking')) setPos(null)
    }
    window.addEventListener('keydown', k)
    window.addEventListener('pointerdown', away)
    return () => {
      window.removeEventListener('keydown', k)
      window.removeEventListener('pointerdown', away)
    }
  }, [pos])

  if (!pos) return null
  return (
    <div className="marking" style={{ left: pos.x, top: pos.y }}>
      <div className="m-center" />
      {SLOTS.map((id, i) => {
        const c = getCommand(id)
        if (!c) return null
        const a = (i * Math.PI) / 4
        return (
          <div
            key={id}
            className="m-item"
            data-hot={hot === i}
            style={{ left: Math.sin(a) * RX, top: -Math.cos(a) * RY }}
            onPointerDown={(e) => {
              if (e.button === 0) {
                e.stopPropagation()
                runCommand(id)
                setPos(null)
              }
            }}
          >
            <c.icon size={13} />
            {SHORT[id] ?? c.label.split(' ')[0]}
          </div>
        )
      })}
    </div>
  )
}
