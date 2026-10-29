import { Tip } from './Tooltip'
import { useState, type ReactNode } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'

/** Collapsible section with a 10px uppercase label. */
export function Section({ title, children, defaultOpen = true, help, onActive }: { title: string; children: ReactNode; defaultOpen?: boolean; help?: string; onActive?: () => void }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="section" onPointerEnter={onActive} onFocusCapture={onActive}>
      <Tip label={title} desc={help ?? 'Click to open or close this group of settings.'} side="left">
        <button type="button" className="section-head" aria-expanded={open} onClick={() => { setOpen(!open); onActive?.() }}>
          {open ? <CaretDown size={9} weight="bold" /> : <CaretRight size={9} weight="bold" />}
          {title}
        </button>
      </Tip>
      {open && <div className="section-body">{children}</div>}
    </div>
  )
}
