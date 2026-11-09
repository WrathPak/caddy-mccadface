/** The build plate under the printer: a compact dropdown of the plates the printer offers, with the ones a loaded filament can't use marked. */
import { useState } from 'react'
import * as P from '@radix-ui/react-popover'
import { CaretDown, Check, Warning } from '@phosphor-icons/react'
import type { Config } from '@muon3d/slicer-engine-protocol'
import { compatiblePlate, plateLabel, plateProblem, unsupportedSlots, type ModelPlates } from './plates'

/** A little slab in perspective: the build plate. */
export function PlateIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.2 9.2 8 6.4l5.8 2.8L8 12z" fill="currentColor" fillOpacity="0.22" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M2.2 9.2v1.6L8 13.6l5.8-2.8V9.2" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

const typeOf = (f: Config) => { const t = f.filament_type; return (Array.isArray(t) ? t[0] : t) || 'This filament' }

/** "PETG not supported" for a plate, or null when every filament prints on it. */
function note(plate: string, filaments: Config[]): string | null {
  const bad = unsupportedSlots(filaments, plate)
  if (!bad.length) return null
  const types = [...new Set(bad.map((i) => typeOf(filaments[i])))]
  return types.length === 1 && bad.length === 1 ? `${types[0]} not supported` : `${bad.length} filaments not supported`
}

export function PlatePicker({ plate, filaments, names, onPick }: {
  plate: ModelPlates & { current: string }; filaments: Config[]; names: string[]; onPick: (plate: string) => void
}) {
  const [open, setOpen] = useState(false)
  const problem = plateProblem(plate.current, filaments, names)
  const fix = problem ? compatiblePlate(plate, filaments) : null
  const label = (
    <>
      <span className="ws-plate-icon"><PlateIcon /></span>
      <span className="ws-plate-name">{plateLabel(plate.current)}</span>
    </>
  )
  return (
    <div className="ws-plate" data-bad={!!problem} data-testid="plate-section">
      {plate.supported.length > 1 ? (
        <P.Root open={open} onOpenChange={setOpen}>
          <P.Trigger asChild>
            <button type="button" className="sel ws-plate-trigger" data-testid="plate-picker" aria-label="Build plate">
              {label}
              {problem && <Warning size={13} weight="fill" className="ws-plate-warnicon" />}
              <CaretDown size={10} />
            </button>
          </P.Trigger>
          <P.Portal>
            <P.Content className="menu sl-pop ws-plate-pop" sideOffset={4} align="start" collisionPadding={12} data-testid="plate-list">
              <div className="sl-grouphead">Build plate</div>
              {plate.supported.map((id) => {
                const why = note(id, filaments)
                const on = id === plate.current
                return (
                  <button type="button" key={id} className="sl-item ws-plate-item" data-active={on} data-dim={!!why} data-testid={`plate-${id.replace(/\s+/g, '-').toLowerCase()}`} onClick={() => { setOpen(false); if (!on) onPick(id) }}>
                    <span className="ws-plate-icon"><PlateIcon size={15} /></span>
                    <span className="ws-plate-itemname">{plateLabel(id)}{id === plate.default && <em>default</em>}</span>
                    {why ? <span className="ws-plate-why">{why}</span> : on ? <Check size={11} /> : null}
                  </button>
                )
              })}
            </P.Content>
          </P.Portal>
        </P.Root>
      ) : (
        <div className="sel ws-plate-trigger" data-readonly="true" data-testid="plate-picker" title="This printer has one build plate">{label}</div>
      )}
      {problem && (
        <div className="ws-plate-warn" role="alert" data-testid="plate-warning">
          <Warning size={14} weight="fill" />
          <span>{problem}</span>
          {fix && <button type="button" className="ws-link" data-testid="plate-fix" onClick={() => onPick(fix)}>Use {plateLabel(fix)}</button>}
        </div>
      )}
    </div>
  )
}
