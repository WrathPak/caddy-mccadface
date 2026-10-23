import * as P from '@radix-ui/react-popover'
import { GearSix } from '@phosphor-icons/react'
import { NAV_PRESETS, useNavSettings } from '@/viewport/navSettings'
import { Checkbox } from './Toggle'

/** Gear in the status bar: viewport navigation preset and inertia. */
export function SettingsPopover() {
  const { preset, setPreset, inertia, setInertia } = useNavSettings()
  const current = NAV_PRESETS.find((p) => p.id === preset)!
  return (
    <P.Root>
      <P.Trigger asChild>
        <button type="button" className="cell gear" title="Settings" aria-label="Settings" data-testid="settings-gear"><GearSix size={13} /></button>
      </P.Trigger>
      <P.Portal>
        <P.Content className="menu settings-pop" side="top" align="end" sideOffset={6} data-testid="settings-popover">
          <div className="settings-title">Navigation</div>
          <div className="opt-list" role="radiogroup" aria-label="Navigation preset">
            {NAV_PRESETS.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={p.id === preset} data-value={p.id} className="opt-row" onClick={() => setPreset(p.id)}>
                <span className="opt-txt"><span className="opt-name">{p.label}</span></span>
              </button>
            ))}
          </div>
          <div className="settings-help">{current.help}</div>
          <Checkbox label="Inertia" help="Keeps the view gliding briefly after you let go of an orbit or pan drag." checked={inertia} onChange={setInertia} />
          <div className="settings-help">Middle-click twice fits everything. F6 fits all, F fits the selection. The wheel (or a pinch) zooms toward the cursor.</div>
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}
