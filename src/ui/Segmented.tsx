import { useRef } from 'react'
import { FieldLabel } from './FieldLabel'
import { useThumb } from './useThumb'

export function Segmented({ value, onChange, options, label, help }: {
  help?: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  label?: string
}) {
  const seg = useRef<HTMLDivElement>(null)
  useThumb(seg, "[aria-checked='true']", value + options.length)
  const ctl = (
    <div className="seg" role="radiogroup" ref={seg}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
  return label ? (
    <div className={'field' + (options.length > 2 ? ' stack' : '')}>
      <FieldLabel label={label} help={help} />
      {ctl}
    </div>
  ) : ctl
}
