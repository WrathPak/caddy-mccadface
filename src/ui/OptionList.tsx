import type { ReactNode } from 'react'
import type { EnumOption } from './schema'

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/** Arrow from (x0,y0) to (x1,y1) with a small head. */
function Arrow({ x0, y0, x1, y1 }: { x0: number; y0: number; x1: number; y1: number }) {
  const a = Math.atan2(y1 - y0, x1 - x0), h = 3.2
  const p = (t: number): [number, number] => [x1 - h * Math.cos(a + t), y1 - h * Math.sin(a + t)]
  const [ax, ay] = p(0.5), [bx, by] = p(-0.5)
  return <path d={`M${x0} ${y0}L${x1} ${y1}M${ax} ${ay}L${x1} ${y1}L${bx} ${by}`} />
}

/** Small pictograms for the hair direction options (and anything else that names an icon). */
const ICONS: Record<string, ReactNode> = {
  perFace: (
    <svg viewBox="0 0 28 28" width="28" height="28" {...S}>
      <path d="M3 24V10l8-6M11 4v14.5M3 24l8-5.5M11 18.5L25 24" opacity="0.55" />
      <Arrow x0={7} y0={17} x1={2} y1={14.5} /><Arrow x0={19} y0={21} x1={24} y1={16} />
    </svg>
  ),
  blend: (
    <svg viewBox="0 0 28 28" width="28" height="28" {...S}>
      <path d="M3 24h12c6 0 9-3 9-9V4" opacity="0.55" />
      <Arrow x0={7} y0={20} x1={7} y1={13} /><Arrow x0={13} y0={20} x1={15} y1={13} /><Arrow x0={19} y0={17} x1={24} y1={12} /><Arrow x0={22} y0={11} x1={26} y1={9} />
    </svg>
  ),
  radial: (
    <svg viewBox="0 0 28 28" width="28" height="28" {...S}>
      <circle cx="14" cy="14" r="1.8" />
      <Arrow x0={14} y0={11} x1={14} y1={3} /><Arrow x0={17} y0={14} x1={25} y1={14} /><Arrow x0={14} y0={17} x1={14} y1={25} /><Arrow x0={11} y0={14} x1={3} y1={14} />
      <Arrow x0={16} y0={12} x1={22} y1={6} /><Arrow x0={12} y0={16} x1={6} y1={22} />
    </svg>
  ),
  fixed: (
    <svg viewBox="0 0 28 28" width="28" height="28" {...S}>
      <Arrow x0={5} y0={23} x1={13} y1={13} /><Arrow x0={11} y0={25} x1={19} y1={15} /><Arrow x0={17} y0={27} x1={25} y1={17} />
    </svg>
  ),
  point: (
    <svg viewBox="0 0 28 28" width="28" height="28" {...S}>
      <circle cx="14" cy="14" r="1.8" />
      <Arrow x0={3} y0={5} x1={11} y1={12} /><Arrow x0={25} y0={5} x1={17} y1={12} /><Arrow x0={3} y0={23} x1={11} y1={16} /><Arrow x0={25} y0={23} x1={17} y1={16} /><Arrow x0={14} y0={2} x1={14} y1={9} />
    </svg>
  ),
}

/** Visual option list: one row per option with a pictogram, a label and a one-line description. */
export function OptionList({ value, options, onChange, label }: { value: string; options: EnumOption[]; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="opt-list" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} data-value={o.value} className="opt-row" onClick={() => onChange(o.value)}>
          <span className="opt-ico">{o.icon ? ICONS[o.icon] : null}</span>
          <span className="opt-txt">
            <span className="opt-name">{o.label}</span>
            {o.desc && <span className="opt-desc">{o.desc}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}
