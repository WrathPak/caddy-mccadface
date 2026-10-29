import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useHelp } from './helpStore'
import { TOUR } from './tourSteps'

interface Box { left: number; top: number; width: number; height: number }

const CARD_W = 300
const GAP = 12
const MARGIN = 8

/** Where the card goes: beside the target on the side asked for if it fits, else the roomiest side; a phone gets a sheet at an edge. */
export function placeCard(target: Box | null, side: string | undefined, vw: number, vh: number, cardH: number): { left: number; top: number; width: number } {
  const narrow = vw < 700
  const width = Math.min(CARD_W, vw - MARGIN * 2)
  if (!target) return { left: (vw - width) / 2, top: Math.max(MARGIN, (vh - cardH) / 2), width }
  if (narrow) {
    // a sheet across the width, at whichever edge the target is not near
    const centre = target.top + target.height / 2
    const top = centre > vh / 2 ? MARGIN : vh - cardH - MARGIN
    return { left: MARGIN, top: Math.max(MARGIN, top), width: vw - MARGIN * 2 }
  }
  const room = {
    right: vw - (target.left + target.width) - GAP - MARGIN,
    left: target.left - GAP - MARGIN,
    bottom: vh - (target.top + target.height) - GAP - MARGIN,
    top: target.top - GAP - MARGIN,
  }
  const fits = (s: keyof typeof room) => (s === 'left' || s === 'right' ? room[s] >= width : room[s] >= cardH)
  const order = (['right', 'left', 'bottom', 'top'] as const)
  const pick = (side && fits(side as keyof typeof room) ? side : order.find(fits)) as keyof typeof room | undefined
  const clampX = (x: number) => Math.min(vw - width - MARGIN, Math.max(MARGIN, x))
  const clampY = (y: number) => Math.min(vh - cardH - MARGIN, Math.max(MARGIN, y))
  switch (pick) {
    case 'right': return { left: target.left + target.width + GAP, top: clampY(target.top + 12), width }
    case 'left': return { left: target.left - GAP - width, top: clampY(target.top + 12), width }
    case 'bottom': return { left: clampX(target.left + 12), top: target.top + target.height + GAP, width }
    case 'top': return { left: clampX(target.left + 12), top: target.top - GAP - cardH, width }
    default: // the target fills the screen: sit inside it, top left
      return { left: clampX(target.left + 12), top: clampY(target.top + 12), width }
  }
}

/** The first-run intro: a dimmed screen with one part lit up and a card that explains it. Skippable at any step. */
export function Tour() {
  const active = useHelp((s) => s.tour)
  const step = useHelp((s) => s.tourStep)
  const setStep = useHelp((s) => s.setTourStep)
  const end = useHelp((s) => s.endTour)
  const card = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<Box | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number }>({ left: 0, top: 0, width: CARD_W })
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight })
  const s = TOUR[Math.min(step, TOUR.length - 1)]
  const last = step >= TOUR.length - 1

  useEffect(() => {
    if (!active) return
    const on = () => setView({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [active])

  // find the part of the screen this step points at (a hidden or missing one means the card sits in the middle)
  useLayoutEffect(() => {
    if (!active) return
    const measure = () => {
      const el = s.target ? document.querySelector<HTMLElement>(s.target) : null
      const r = el?.getBoundingClientRect()
      setBox(r && r.width > 4 && r.height > 4 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null)
    }
    measure()
    // docked panels settle a moment after the first paint
    const t = setTimeout(measure, 120)
    return () => clearTimeout(t)
  }, [active, step, s.target, view])

  useLayoutEffect(() => {
    if (!active) return
    const h = card.current?.offsetHeight ?? 160
    setPos(placeCard(box, s.side, view.w, view.h, h))
  }, [active, box, step, s.side, view])

  useEffect(() => {
    if (!active) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (!last) setStep(step + 1) }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (step > 0) setStep(step - 1) }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [active, step, last, setStep, end])

  useEffect(() => { if (active) card.current?.querySelector<HTMLElement>('[data-tour-next]')?.focus() }, [active, step])

  if (!active) return null
  return (
    <div className="tour" data-testid="tour">
      <div className="tour-block" data-spot={!!box} />
      {box && <div className="tour-spot" style={{ left: box.left - 3, top: box.top - 3, width: box.width + 6, height: box.height + 6 }} />}
      <div ref={card} className="tour-card" role="dialog" aria-modal="true" aria-label="Intro tour" data-help-dialog data-testid="tour-card" data-step={s.id} style={{ left: pos.left, top: pos.top, width: pos.width }}>
        <div className="tour-count">Step {step + 1} of {TOUR.length}</div>
        <h3>{s.title}</h3>
        <p>{s.body}</p>
        <div className="tour-actions">
          <button type="button" className="btn" data-testid="tour-skip" onClick={end}>{last ? 'Close' : 'Skip tour'}</button>
          <span className="grow" />
          {step > 0 && <button type="button" className="btn" data-testid="tour-back" onClick={() => setStep(step - 1)}>Back</button>}
          <button type="button" className="btn primary" data-tour-next data-testid="tour-next" onClick={() => (last ? end() : setStep(step + 1))}>{last ? 'Done' : 'Next'}</button>
        </div>
      </div>
    </div>
  )
}
