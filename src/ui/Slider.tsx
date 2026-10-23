import * as S from '@radix-ui/react-slider'

export function Slider({ value, onChange, min = 0, max = 100, step = 1, label }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label?: string
}) {
  const ctl = (
    <S.Root className="slider" value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])}>
      <S.Track className="slider-track"><S.Range className="slider-range" /></S.Track>
      <S.Thumb className="slider-thumb" />
    </S.Root>
  )
  return label ? (
    <div className="field">
      <span className="field-label">{label}</span>
      {ctl}
    </div>
  ) : ctl
}
