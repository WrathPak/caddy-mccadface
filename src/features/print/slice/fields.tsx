/** The controls of the settings panel: one cell of Orca's settings form, edited as Orca's text. */
import { useEffect, useState } from 'react'
import * as S from '@radix-ui/react-select'
import { ArrowCounterClockwise, CaretDown, Check } from '@phosphor-icons/react'
import type { FormOption, ViewCell } from '@muon3d/slicer-engine-protocol'
import { Checkbox } from '@/ui/Toggle'
import { Tip } from '@/ui/Tooltip'

export interface CellProps {
  opt: FormOption
  cell: ViewCell
  onEdit: (text: string, index?: number) => void
  disabled?: boolean
}

const label = (opt: FormOption, v: string) => opt.enum?.find((e) => e.value === v)?.label ?? v

/** A text box that commits on Enter or when it loses focus, and takes the engine's value back after every edit. */
function TextBox({ value, onCommit, mono, area, unit, disabled, numeric, width }: { value: string; onCommit: (v: string) => void; mono?: boolean; area?: boolean; unit?: string; disabled?: boolean; numeric?: boolean; width?: number }) {
  const [text, setText] = useState(value)
  const [focus, setFocus] = useState(false)
  useEffect(() => { if (!focus) setText(value) }, [value, focus])
  const commit = () => { setFocus(false); if (text !== value) onCommit(text) }
  const common = {
    value: text, disabled, spellCheck: false as const,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setText(e.target.value),
    onFocus: () => setFocus(true), onBlur: commit,
    className: 'sl-input' + (mono ? ' mono' : ''),
  }
  return (
    <span className="sl-box" style={width ? { width } : undefined}>
      {area
        ? <textarea {...common} rows={4} />
        : <input {...common} inputMode={numeric ? 'decimal' : undefined} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(value); (e.target as HTMLInputElement).blur() } }} />}
      {unit && <span className="sl-unit">{unit}</span>}
    </span>
  )
}

function EnumBox({ opt, cell, onEdit, disabled }: CellProps) {
  const value = cell.value ?? ''
  const choices = cell.choices ?? opt.enum?.map((e) => e.value) ?? []
  const list = choices.includes(value) || !value ? choices : [value, ...choices]
  return (
    <S.Root value={value} onValueChange={(v) => onEdit(v)} disabled={disabled}>
      <S.Trigger className="sel sl-select"><span className="sl-sel-text"><S.Value>{label(opt, value)}</S.Value></span><S.Icon><CaretDown size={10} /></S.Icon></S.Trigger>
      <S.Portal>
        <S.Content className="menu sl-menu" position="popper" sideOffset={2} style={{ minWidth: 'var(--radix-select-trigger-width)' }}>
          <S.Viewport>
            {list.map((v) => (
              <S.Item key={v} value={v} className="menu-item"><S.ItemText>{label(opt, v)}</S.ItemText><S.ItemIndicator style={{ marginLeft: 'auto' }}><Check size={10} /></S.ItemIndicator></S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
}

/** One cell of a row, as the control its option asks for. */
export function Cell(p: CellProps) {
  const { opt, cell, onEdit, disabled } = p
  const dis = disabled || cell.disabled
  const value = cell.value ?? ''
  const idx = cell.index
  switch (opt.control) {
    case 'bool':
      return <Checkbox checked={value === '1' || value === 'true'} onChange={(v) => !dis && onEdit(v ? '1' : '0', idx)} ariaLabel={opt.label} />
    case 'enum':
      return <EnumBox {...p} disabled={dis} />
    case 'color':
      return <input type="color" className="sl-color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff'} disabled={dis} onChange={(e) => onEdit(e.target.value.toUpperCase(), idx)} />
    case 'code':
      return <TextBox value={value} onCommit={(v) => onEdit(v, idx)} mono area disabled={dis} />
    case 'number':
    case 'floatOrPercent':
      return <TextBox value={value} onCommit={(v) => onEdit(v, idx)} unit={opt.unit} disabled={dis} numeric width={opt.control === 'floatOrPercent' ? 112 : 96} />
    default:
      return <TextBox value={value} onCommit={(v) => onEdit(v, idx)} mono={opt.serialized || opt.openEnum} area={opt.multiline} unit={opt.unit} disabled={dis} />
  }
}

/** The "modified" dot and reset arrow of a setting. */
export function ModifiedMark({ modified, onReset, label: name }: { modified: boolean; onReset: () => void; label: string }) {
  if (!modified) return <span className="sl-mark" aria-hidden />
  return (
    <Tip label={`${name} was changed`} desc="Click to go back to the preset's value." side="top">
      <button type="button" className="sl-mark on" aria-label={`Reset ${name}`} data-testid="reset-setting" onClick={onReset}><ArrowCounterClockwise size={12} weight="bold" /></button>
    </Tip>
  )
}
