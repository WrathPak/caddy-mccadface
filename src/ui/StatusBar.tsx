import * as D from '@radix-ui/react-dropdown-menu'
import { useUi, type SelectionFilter } from '@/store/ui'

const FILTERS: SelectionFilter[] = ['body', 'face', 'edge']

export function StatusBar() {
  const { units, setUnits, snap, toggleSnap, selectionFilter, setSelectionFilter, triangles, kernelBusy, selection } = useUi()
  return (
    <div className="status">
      <D.Root>
        <D.Trigger asChild>
          <button type="button" className="cell">Units: <span className="num">{units}</span></button>
        </D.Trigger>
        <D.Portal>
          <D.Content className="menu" side="top" align="start">
            {(['mm', 'in'] as const).map((u) => <D.Item key={u} className="menu-item" onSelect={() => setUnits(u)}>{u}</D.Item>)}
          </D.Content>
        </D.Portal>
      </D.Root>
      <button type="button" className="cell" onClick={toggleSnap}>Snap: <span className="num" style={{ color: snap ? 'var(--accent)' : undefined }}>{snap ? 'On' : 'Off'}</span></button>
      <D.Root>
        <D.Trigger asChild>
          <button type="button" className="cell">Select: <span className="num" style={{ textTransform: 'capitalize' }}>{selectionFilter}</span></button>
        </D.Trigger>
        <D.Portal>
          <D.Content className="menu" side="top" align="start">
            {FILTERS.map((f) => <D.Item key={f} className="menu-item" style={{ textTransform: 'capitalize' }} onSelect={() => setSelectionFilter(f)}>{f}</D.Item>)}
          </D.Content>
        </D.Portal>
      </D.Root>
      <span className="cell">{selection.length ? `${selection.length} selected` : 'Nothing selected'}</span>
      <span className="grow" />
      <span className="cell">Tris: <span className="num">{triangles.toLocaleString()}</span></span>
      <span className="cell" title={kernelBusy ? 'Kernel busy' : 'Kernel idle'}>
        <span className={'dot ' + (kernelBusy ? 'busy' : 'idle')} />
        Kernel: {kernelBusy ? 'Busy' : 'Idle'}
      </span>
    </div>
  )
}
