import { useEffect, useRef, useState, type ReactNode } from 'react'
import { evaluate } from 'mathjs'

export interface NumberFieldProps {
  label?: string
  value: number
  onChange: (v: number) => void
  unit?: string
  min?: number
  max?: number
  step?: number
  /** decimals shown */
  precision?: number
  /** small node inside the left of the input (e.g. axis letter) */
  prefix?: ReactNode
  disabled?: boolean
}

const clamp = (v: number, min?: number, max?: number) =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))

const fmt = (v: number, p: number) => String(+v.toFixed(p))

/** Evaluate an expression (mathjs). Returns a number in `unit`, or null if invalid. */
export function evalExpr(text: string, unit?: string): number | null {
  const t = text.trim()
  if (!t) return null
  try {
    const r: unknown = evaluate(t)
    if (typeof r === 'number' && isFinite(r)) return r
    if (r && typeof r === 'object' && 'toNumber' in r && unit) {
      const n = (r as { toNumber: (u: string) => number }).toNumber(unit)
      if (isFinite(n)) return n
    }
  } catch {
    /* invalid expression */
  }
  return null
}

export function NumberField({ label, value, onChange, unit, min, max, step = 1, precision = 3, prefix, disabled }: NumberFieldProps) {
  const [text, setText] = useState(fmt(value, precision))
  const [editing, setEditing] = useState(false)
  const [bad, setBad] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setText(fmt(value, precision))
  }, [value, editing, precision])

  const commit = () => {
    const r = evalExpr(text, unit)
    if (r === null) {
      setBad(true)
      setText(fmt(value, precision))
      setTimeout(() => setBad(false), 600)
    } else {
      const v = clamp(r, min, max)
      onChange(v)
      setText(fmt(v, precision))
    }
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit()
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setText(fmt(value, precision))
      inputRef.current?.blur()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const m = e.shiftKey ? 10 : e.altKey ? 0.1 : 1
      const v = clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * step * m, min, max)
      onChange(v)
      setText(fmt(v, precision))
    }
  }

  // drag-to-scrub on the label (Shift = x10, Alt = x0.1)
  const onScrub = (e: React.PointerEvent<HTMLElement>) => {
    if (disabled) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let acc = value
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
          if (editing) commit()
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
      <span className="field-label scrub" onPointerDown={onScrub} title="Drag to adjust">
        {label}
      </span>
      {input}
    </div>
  )
}
