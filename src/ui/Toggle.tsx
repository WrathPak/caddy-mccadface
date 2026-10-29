import * as C from '@radix-ui/react-checkbox'
import { Check } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import { FieldLabel } from './FieldLabel'
import { Tip } from './Tooltip'

export function Checkbox({ checked, onChange, label, help, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label?: string; help?: string; /** the accessible name when there is no visible label */ ariaLabel?: string }) {
  const box = (
    <C.Root className="chk" aria-label={label ?? ariaLabel} checked={checked} onCheckedChange={(v) => onChange(v === true)}>
      <C.Indicator><Check size={9} weight="bold" /></C.Indicator>
    </C.Root>
  )
  if (!label) return box
  return (
    <div className="field">
      <FieldLabel label={label} help={help} />
      <div>{box}</div>
    </div>
  )
}

/** Pressed/unpressed button for toolbars (styled by .vp-bar button[data-active]). */
export function Toggle({ pressed, onChange, children, title }: { pressed: boolean; onChange: (v: boolean) => void; children: ReactNode; title?: string }) {
  const btn = (
    <button type="button" aria-pressed={pressed} data-active={pressed} onClick={() => onChange(!pressed)}>
      {children}
    </button>
  )
  return title ? <Tip label={title} side="top">{btn}</Tip> : btn
}
