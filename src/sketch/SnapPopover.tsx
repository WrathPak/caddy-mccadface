/** Snap and inference settings: a checkbox per relation, opened from the status bar or the Sketch ribbon. */
import * as P from '@radix-ui/react-popover'
import { CaretUp } from '@phosphor-icons/react'
import { create } from 'zustand'
import { SNAP_LABELS, useSnapFlags } from './snapSettings'

export const useSnapUi = create<{ open: boolean; setOpen(o: boolean): void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }))

export function SnapPopover() {
  const { open, setOpen } = useSnapUi()
  const { flags, set, reset } = useSnapFlags()
  return (
    <P.Root open={open} onOpenChange={setOpen}>
      <P.Trigger asChild>
        <button type="button" className="cell" aria-label="Snap settings" title="Snap and inference settings" data-testid="snap-settings"><CaretUp size={10} weight="bold" /></button>
      </P.Trigger>
      <P.Portal>
        <P.Content className="menu" side="top" align="start" sideOffset={6} data-testid="snap-popover" style={{ padding: 10, minWidth: 250 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Snap and inference</div>
          {SNAP_LABELS.map((s) => (
            <label key={s.key} title={s.help} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', cursor: 'pointer' }}>
              <input type="checkbox" data-testid={'snap-' + s.key} checked={flags[s.key]} onChange={(e) => set(s.key, e.target.checked)} />
              {s.label}
            </label>
          ))}
          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', color: 'var(--text-dim)', fontSize: 11 }}>
            <span>Hold Ctrl to pause, Shift to lock</span>
            <button type="button" className="btn" onClick={reset}>Reset</button>
          </div>
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}
