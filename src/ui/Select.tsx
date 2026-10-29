import * as S from '@radix-ui/react-select'
import { CaretDown, Check } from '@phosphor-icons/react'
import { FieldLabel } from './FieldLabel'

export interface Option { value: string; label: string }

export function Select({ value, onChange, options, label, help, placeholder }: {
  help?: string
  placeholder?: string
  value: string
  onChange: (v: string) => void
  options: Option[]
  label?: string
}) {
  const ctl = (
    <S.Root value={value} onValueChange={onChange}>
      <S.Trigger className="sel">
        <S.Value placeholder={placeholder} />
        <S.Icon><CaretDown size={10} /></S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content className="menu" position="popper" sideOffset={2} style={{ minWidth: 'var(--radix-select-trigger-width)' }}>
          <S.Viewport>
            {options.map((o) => (
              <S.Item key={o.value} value={o.value} className="menu-item">
                <S.ItemText>{o.label}</S.ItemText>
                <S.ItemIndicator style={{ marginLeft: 'auto' }}><Check size={10} /></S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
  return label ? (
    <div className="field">
      <FieldLabel label={label} help={help} />
      {ctl}
    </div>
  ) : ctl
}
