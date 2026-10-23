import { useState, type ReactNode } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'

/** Collapsible section with a 10px uppercase label. */
export function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="section">
      <button type="button" className="section-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <CaretDown size={9} weight="bold" /> : <CaretRight size={9} weight="bold" />}
        {title}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  )
}
