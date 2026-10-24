import { useRef } from 'react'
import * as S from '@radix-ui/react-slider'

export function Slider({ value, onChange, onCommit, min = 0, max = 100, step = 1, label, testId }: {
  value: number; onChange: (v: number) => void; /** called once when the drag (or key press) ends */ onCommit?: (v: number) => void; min?: number; max?: number; step?: number; label?: string; testId?: string
}) {
  const latest = useRef(value)
  latest.current = value
  // Radix reports the end of a pointer drag; a key press is committed when the key comes up
  const ctl = (
    <S.Root className="slider" data-testid={testId} value={[value]} min={min} max={max} step={step} onValueChange={(v) => { latest.current = v[0]; onChange(v[0]) }} onValueCommit={(v) => onCommit?.(v[0])}
      onKeyUp={(e) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) onCommit?.(latest.current) }}>
      <S.Track className="slider-track"><S.Range className="slider-range" /></S.Track>
      <S.Thumb className="slider-thumb" />
    </S.Root>
  )
  return label ? (
    <div className="field">
      <span className="field-label" title={label}>{label}</span>
      {ctl}
    </div>
  ) : ctl
}
