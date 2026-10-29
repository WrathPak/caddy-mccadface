import * as D from '@radix-ui/react-dropdown-menu'
import { useUi, type SelectionFilter } from '@/store/ui'
import { useHairView } from '@/features/hair/store'
import { useDoc } from '@/doc/store'
import { SettingsButton } from './SettingsDialog'
import { Tip } from './Tooltip'
import { SnapPopover } from '@/sketch/SnapPopover'
import { useDevice } from '@/app/device'

const FILTERS: SelectionFilter[] = ['body', 'face', 'edge']

export function StatusBar() {
  const { units, setUnits, snap, toggleSnap, selectionFilter, setSelectionFilter, triangles, kernelBusy, selection } = useUi()
  const hair = useHairView()
  const hasComponents = useDoc((s) => s.assembly.occurrences.length > 0)
  const section = useUi((s) => s.section)
  const hs = hair.result?.stats
  const compact = useDevice((s) => s.compact)
  return (
    <div className="status">
      <D.Root>
        <Tip label="Units" desc="The unit used in size fields: millimetres or inches. Your model is stored in millimetres either way, so switching never changes it." side="top">
          <D.Trigger asChild>
            <button type="button" className="cell" data-testid="units-cell">{compact ? null : 'Units: '}<span className="num">{units}</span></button>
          </D.Trigger>
        </Tip>
        <D.Portal>
          <D.Content className="menu" side="top" align="start">
            {(['mm', 'in'] as const).map((u) => <D.Item key={u} className="menu-item" onSelect={() => setUnits(u)}>{u}</D.Item>)}
          </D.Content>
        </D.Portal>
      </D.Root>
      <Tip label="Snap" desc="When on, sketch points jump to nearby points, lines and the grid, so shapes line up exactly. Click to turn it on or off." side="top">
        <button type="button" className="cell" onClick={toggleSnap}>{compact ? 'Snap' : 'Snap:'} <span className="num" style={{ color: snap ? 'var(--accent)' : undefined }}>{snap ? 'On' : 'Off'}</span></button>
      </Tip>
      <SnapPopover />
      <D.Root>
        <Tip label="Select filter" desc="What a click picks in the viewport: whole bodies, single faces, or edges. Pick Face to push or round a face, Edge before a fillet, Body to move things." side="top">
          <D.Trigger asChild>
            <button type="button" className="cell">{compact ? 'Pick ' : 'Select: '}<span className="num" style={{ textTransform: 'capitalize' }}>{selectionFilter}</span></button>
          </D.Trigger>
        </Tip>
        <D.Portal>
          <D.Content className="menu" side="top" align="start">
            {(hasComponents ? [...FILTERS, 'component' as const] : FILTERS).map((f) => <D.Item key={f} className="menu-item" style={{ textTransform: 'capitalize' }} onSelect={() => setSelectionFilter(f)}>{f}</D.Item>)}
          </D.Content>
        </D.Portal>
      </D.Root>
      {section.on && (
        <Tip label="Section" desc="The view is sliced by a cutting plane. Click to remove the section." side="top"><button type="button" className="cell" data-testid="section-chip" onClick={() => useUi.getState().setSection({ on: false })}>
          Section: <span className="num" style={{ color: 'var(--accent)' }}>{section.axis} = {+section.offset.toFixed(3)} mm</span> ×
        </button></Tip>
      )}
      <Tip label="Selection" desc="How many things you have picked. Press Esc to clear the selection." side="top"><span className="cell">{selection.length ? `${selection.length} selected` : compact ? 'None' : 'Nothing selected'}</span></Tip>
      {(hs || hair.error || hair.busy) && (
        <span className="cell" title={hair.error ?? undefined} style={hair.error ? { color: 'var(--danger, #d9625a)' } : undefined}>
          {hair.error ? `Hair: ${hair.error}` : hs ? `Hair: ${hs.strands.toLocaleString()} strands${hs.dropped ? ` (${hs.dropped} skipped)` : ''}${hs.edgeRejected ? ` (${hs.edgeRejected} kept off edges)` : ''}${hs.bent ? ` (${hs.bent} bent)` : ''}${hs.collided ? ` (${hs.collided} removed: collision)` : ''}${hs.capped ? ' (capped)' : ''} | ${Math.round(hs.triangles / 1000).toLocaleString()}k tris | ${hs.ms} ms${hair.busy ? ' ...' : ''}` : 'Hair: generating ...'}
        </span>
      )}
      <span className="grow" />
      <Tip label="Triangles" desc="How many small triangles are drawn to show your model. Very high numbers can make the view slower." side="top"><span className="cell hide-compact">Tris: <span className="num">{triangles.toLocaleString()}</span></span></Tip>
      <Tip label={kernelBusy ? 'Kernel busy' : 'Kernel idle'} desc="The kernel is the part that does the geometry math. It shows Busy while it is rebuilding your model; edits wait until it is done." side="top">
        <span className="cell">
          <span className={'dot ' + (kernelBusy ? 'busy' : 'idle')} />
          {compact ? (kernelBusy ? 'Busy' : null) : <>Kernel: {kernelBusy ? 'Busy' : 'Idle'}</>}
        </span>
      </Tip>
      <SettingsButton />
    </div>
  )
}
