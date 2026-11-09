/** The Quick tab: printer, process and filament presets, then the settings people change most, written to Orca's own keys. */
import { useMemo } from 'react'
import { Segmented } from '@/ui/Segmented'
import { Select } from '@/ui/Select'
import { Tip } from '@/ui/Tooltip'
import { FILAMENT_COLORS } from '../palette'
import { updatePrintSettings, currentSettings } from '../settings'
import { applyValues, editSetting, resetSetting, setFilament, setPrinter, setProcess, slotCount } from './controller'
import { Cell, ModifiedMark } from './fields'
import { PresetPicker, PrinterPicker, usePresetNames } from './Pickers'
import { useSlicer } from './store'
import { refOf } from './userPresets'
import type { SliceProfile } from './profile'
import type { FormOption } from '@muon3d/slicer-engine-protocol'

const num = (unit?: string): FormOption => ({ key: '', type: 'float', control: 'number', label: '', mode: 'simple', unit })
const pct = (): FormOption => ({ key: '', type: 'float', control: 'floatOrPercent', label: '', mode: 'simple', unit: '%' })

const PATTERNS = ['gyroid', 'grid', 'cubic', 'adaptivecubic', 'honeycomb', '3dhoneycomb', 'line', 'rectilinear', 'alignedrectilinear', 'zig-zag', 'concentric', 'triangles', 'tri-hexagon', 'crosshatch', 'lightning', '2dlattice', 'hilbertcurve', 'archimedeanchords', 'octagramspiral', 'supportcubic']
const patternLabel = (v: string) => (v === 'line' ? 'Lines' : v.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()))
const patternOptions = (cur: string) => (PATTERNS.includes(cur) || !cur ? PATTERNS : [cur, ...PATTERNS]).map((v) => ({ value: v, label: patternLabel(v) }))

const text = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

function QRow({ label, help, keys, profile, children }: { label: string; help: string; keys: string[]; profile: SliceProfile; children: React.ReactNode }) {
  const modified = keys.filter((k) => k in profile.overrides.process)
  return (
    <div className="sl-row sl-qrow" data-testid={`quick-${keys[0]}`}>
      <ModifiedMark modified={modified.length > 0} label={label} onReset={() => modified.forEach((k) => void resetSetting('process', k))} />
      <Tip label={label} desc={help} side="top"><span className="sl-label">{label}</span></Tip>
      <div className="sl-cells">{children}</div>
    </div>
  )
}

export function QuickTab({ profile }: { profile: SliceProfile }) {
  const resolved = useSlicer((s) => s.resolved)
  const p = resolved?.process
  const set = (key: string) => (t: string) => void editSetting('process', key, t)
  const names = usePresetNames('process', profile.vendor, profile.machine)
  const slots = slotCount()
  const fil = Array.from({ length: slots }, (_, i) => i)
  const settings = currentSettings()
  const colorOpts = useMemo(() => FILAMENT_COLORS.map((c) => ({ value: c.id, label: c.label })), [])
  const filNames = [usePresetNames('filament', profile.vendor, profile.machine, resolved?.processName)][0]
  if (!p) return <p className="sl-empty">Loading presets ...</p>
  const val = (k: string) => text(p[k])
  const cell = (k: string, opt: FormOption) => <Cell opt={{ ...opt, key: k }} cell={{ key: k, value: val(k) }} onEdit={set(k)} />
  const enabled = val('enable_support') === '1'
  const style = val('support_type').startsWith('tree') ? 'tree' : 'normal'
  const mode = !enabled ? 'off' : val('support_type').includes('manual') ? 'manual' : 'auto'
  const setSupport = (m: string, st: string) => void applyValues('process', m === 'off' ? { enable_support: '0' } : { enable_support: '1', support_type: `${st}(${m === 'manual' ? 'manual' : 'auto'})` })
  const brim = val('brim_type') === 'no_brim' ? 'none' : val('brim_type') === 'outer_only' ? 'outer' : val('brim_type') === 'auto_brim' ? 'auto' : val('brim_type')
  return (
    <div className="sl-quick" data-testid="quick-tab">
      <section className="sl-group">
        <h4>Printer and materials</h4>
        <div className="sl-presets">
          <div><span className="sl-fieldlabel">Printer</span><PrinterPicker machine={profile.machine} onPick={(m) => void setPrinter(m)} /></div>
          <PresetPicker
            type="process" label="Process" vendor={profile.vendor} name={resolved.processName} userName={profile.user.process?.name} names={names}
            modified={Object.keys(profile.overrides.process).length > 0} onPick={(n) => void setProcess(n)} onPickUser={(u) => void setProcess(u.inherits, refOf(u))}
          />
          {fil.map((i) => (
            <div key={i} className="sl-slot">
              <PresetPicker
                type="filament" label={slots > 1 ? `Filament ${i + 1}` : 'Filament'} vendor={profile.vendor} name={resolved.filamentNames[i] ?? ''} userName={profile.user.filaments[i]?.name} names={filNames}
                modified={Object.keys(profile.overrides.filaments[i] ?? {}).length > 0} onPick={(n) => void setFilament(i, n)} onPickUser={(u) => void setFilament(i, u.inherits, refOf(u))}
              />
              <div className="sl-colorsel">
                <span className="sl-swatch" style={{ background: FILAMENT_COLORS.find((c) => c.id === settings.slotColors[i])?.hex }} />
                <Select value={settings.slotColors[i]} options={colorOpts} onChange={(v) => updatePrintSettings(() => ({ [`slot${i + 1}`]: v }), 'Filament color')} />
              </div>
            </div>
          ))}
        </div>
        {slots === 1 && <p className="sl-hint">Paint a body or a face with Filament 2 or more to print in several colors; each filament gets its own preset here.</p>}
      </section>
      <section className="sl-group">
        <h4>Quality and strength</h4>
        <QRow label="Layer height" keys={['layer_height']} profile={profile} help="Thickness of each printed layer in mm. Thinner layers look smoother and print slower.">{cell('layer_height', num('mm'))}</QRow>
        <QRow label="First layer height" keys={['initial_layer_print_height']} profile={profile} help="Thickness of the very first layer in mm. A little thicker than the rest helps it stick to the plate.">{cell('initial_layer_print_height', num('mm'))}</QRow>
        <QRow label="Wall loops" keys={['wall_loops']} profile={profile} help="How many outlines are printed around each layer. More loops make the part stronger and its walls thicker.">{cell('wall_loops', num())}</QRow>
        <QRow label="Top layers" keys={['top_shell_layers']} profile={profile} help="How many solid layers close the top of the part.">{cell('top_shell_layers', num())}</QRow>
        <QRow label="Bottom layers" keys={['bottom_shell_layers']} profile={profile} help="How many solid layers close the bottom of the part.">{cell('bottom_shell_layers', num())}</QRow>
        <QRow label="Infill" keys={['sparse_infill_density']} profile={profile} help="How full the inside of the part is, in percent. 0 makes it hollow, 100 makes it solid.">{cell('sparse_infill_density', pct())}</QRow>
        <QRow label="Infill pattern" keys={['sparse_infill_pattern']} profile={profile} help="The pattern that fills the inside of the part. Gyroid is strong in every direction.">
          <Select value={val('sparse_infill_pattern')} onChange={set('sparse_infill_pattern')} options={patternOptions(val('sparse_infill_pattern'))} />
        </QRow>
      </section>
      <section className="sl-group">
        <h4>Support and adhesion</h4>
        <QRow label="Support" keys={['enable_support', 'support_type']} profile={profile} help="Scaffolding under overhangs. Auto adds it where the slicer finds overhangs. Painted only adds it just where you paint a support enforcer.">
          <Segmented value={mode} onChange={(m) => setSupport(m, style)} options={[{ value: 'off', label: 'Off' }, { value: 'auto', label: 'Auto' }, { value: 'manual', label: 'Painted only' }]} />
        </QRow>
        {mode !== 'off' && (
          <QRow label="Support style" keys={['support_type']} profile={profile} help="Normal builds straight pillars. Tree builds branching ones that touch less of the part and are easier to remove.">
            <Segmented value={style} onChange={(st) => setSupport(mode, st)} options={[{ value: 'normal', label: 'Normal' }, { value: 'tree', label: 'Tree' }]} />
          </QRow>
        )}
        <QRow label="Support angle" keys={['support_threshold_angle']} profile={profile} help="Overhangs flatter than this angle (from the plate) get support. Larger values support more of the part.">{cell('support_threshold_angle', num('deg'))}</QRow>
        <QRow label="Brim" keys={['brim_type']} profile={profile} help="A flat ring around the first layer that helps tall or thin parts stay stuck to the plate.">
          <Segmented value={brim} onChange={(b) => set('brim_type')(b === 'none' ? 'no_brim' : b === 'outer' ? 'outer_only' : 'auto_brim')} options={[{ value: 'none', label: 'None' }, { value: 'auto', label: 'Auto' }, { value: 'outer', label: 'Outer' }]} />
        </QRow>
      </section>
      <section className="sl-group">
        <h4>Plate</h4>
        <div className="sl-row sl-qrow">
          <span className="sl-mark" aria-hidden />
          <Tip label="Plate layout" desc="Arrange lays every body out side by side on the plate. Keep centers them on the plate where they sit relative to each other." side="top"><span className="sl-label">Plate layout</span></Tip>
          <div className="sl-cells">
            <Segmented value={settings.placement} onChange={(v) => updatePrintSettings(() => ({ placement: v }), 'Plate layout')} options={[{ value: 'arrange', label: 'Arrange' }, { value: 'keep', label: 'Keep' }]} />
          </div>
        </div>
      </section>
    </div>
  )
}
