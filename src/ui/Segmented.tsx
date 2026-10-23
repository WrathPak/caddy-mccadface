export function Segmented({ value, onChange, options, label }: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  label?: string
}) {
  const ctl = (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
  return label ? (
    <div className={'field' + (options.length > 2 ? ' stack' : '')}>
      <span className="field-label" title={label}>{label}</span>
      {ctl}
    </div>
  ) : ctl
}
