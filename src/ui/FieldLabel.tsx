import type { ReactNode } from 'react'
import { Tip } from './Tooltip'

/** The label of an Inspector field. With a help text it shows a tooltip card on hover (the card opens to the left, over the viewport). */
export function FieldLabel({ label, help, children, className = 'field-label' }: { label: string; help?: string; children?: ReactNode; className?: string }) {
  const span = <span className={className}>{children ?? label}</span>
  return help ? <Tip label={label} desc={help} side="left">{span}</Tip> : span
}
