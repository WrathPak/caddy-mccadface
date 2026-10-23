import { useEffect, useRef, useState, type ReactNode } from 'react'
import { evalNumber } from '@/doc/params'

export interface NumberFieldProps {
  label?: string
  value: number | undefined
  onChange: (v: number, expr?: string) => void
  /** expression text (references user parameters) to display instead of the number */
  expr?: string
  unit?: string
  min?: number
  max?: number
  step?: number
  /** decimals shown */
  precision?: number
  /** small node inside the left of the input (e.g. axis letter) */
  prefix?: ReactNode
  disabled?: boolean
  /** plain-language explanation shown as the label tooltip */
  help?: string
}

const clamp = (v: number, min?: number, max?: number) =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))

const fmt = (v: number | undefined, p: number) =>
  typeof v === 'number' && Number.isFinite(v) ? String(+v.toFixed(p)) : ''

/** Evaluate an expression (mathjs, with user parameters). Returns a number in `unit`, or null if invalid. */
export const evalExpr = (text: string, unit?: string): number | null => evalNumber(text, unit)

export function NumberField({ label, value, onChange, expr, unit, min, max, step = 1, precision = 3, prefix, disabled, help }: NumberFieldProps) {
  const [text, setText] = useState(expr ?? fmt(value, precision))
  const [editing, setEditing] = useState(false)
  const [bad, setBad] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const escaped = useRef(false)

  useEffect(() => {
    if (!editing) setText(expr ?? fmt(value, precision))
  }, [value, editing, precision, expr])

  const commit = () => {
    const r = evalExpr(text, unit)
    if (r === null) {
      setBad(true)
      setText(fmt(value, precision))
      setTimeout(() => setBad(false), 600)
    } else {
      const v = clamp(r, min, max)
      const t = text.trim()
      const plain = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)
      onChange(v, plain ? undefined : t)
      setText(plain ? fmt(v, precision) : t)
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit()
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      // a pending edit is reverted first; with nothing to revert the key reaches the dialog (which cancels)
      if (text !== fmt(value, precision) && !expr) {
        e.stopPropagation()
        escaped.current = true // the blur below must not commit the abandoned text
        setText(fmt(value, precision))
      }
      inputRef.current?.blur()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const m = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
      const v = clamp((Number.isFinite(value) ? (value as number) : 0) + (e.key === 'ArrowUp' ? 1 : -1) * step * m, min, max)
      onChange(v)
      setText(fmt(v, precision))
    }
  }

  // drag-to-scrub on the label (Shift = x10, Alt = x0.1)
  const onScrub = (e: React.PointerEvent<HTMLElement>) => {
    if (disabled) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let acc = Number.isFinite(value) ? (value as number) : 0
    const move = (ev: PointerEvent) => {
      const m = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1
      acc = clamp(acc + ev.movementX * step * 0.5 * m, min, max)
      onChange(+acc.toFixed(precision))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const input = (
    <div className={'inp' + (bad ? ' err' : '')}>
      {prefix}
      <input
        ref={inputRef}
        value={text}
        disabled={disabled}
        spellCheck={false}
        onFocus={(e) => {
          setEditing(true)
          e.currentTarget.select()
        }}
        onBlur={() => {
          if (editing && !escaped.current) commit()
          escaped.current = false
          setEditing(false)
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  )
  if (!label) return input
  return (
    <div className="field">
      <span className="field-label scrub" onPointerDown={onScrub} title={help ? help + ' (drag the label to adjust)' : label + ' (drag to adjust)'}>
        {label}
      </span>
      {input}
    </div>
  )
}
