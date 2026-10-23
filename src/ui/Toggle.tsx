import * as C from '@radix-ui/react-checkbox'
import { Check } from '@phosphor-icons/react'
import type { ReactNode } from 'react'

export function Checkbox({ checked, onChange, label, help }: { checked: boolean; onChange: (v: boolean) => void; label?: string; help?: string }) {
  const box = (
    <C.Root className="chk" aria-label={label} checked={checked} onCheckedChange={(v) => onChange(v === true)}>
      <C.Indicator><Check size={9} weight="bold" /></C.Indicator>
    </C.Root>
  )
  if (!label) return box
  return (
    <div className="field">
      <span className="field-label" title={help ?? label}>{label}</span>
      <div>{box}</div>
    </div>
  )
}

/** Pressed/unpressed button for toolbars (styled by .vp-bar button[data-active]). */
export function Toggle({ pressed, onChange, children, title }: { pressed: boolean; onChange: (v: boolean) => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" title={title} aria-pressed={pressed} data-active={pressed} onClick={() => onChange(!pressed)}>
      {children}
    </button>
  )
}
