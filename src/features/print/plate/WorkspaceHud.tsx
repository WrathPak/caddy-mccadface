/** The Print workspace over the viewport: the Prepare / Preview switch with the Slice button, the object toolbar, the part readout, and on a phone the setup sheet. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowCounterClockwise, ArrowFatLineDown, ArrowsCounterClockwise, ArrowsOutCardinal, CaretUp, CircleNotch, MagicWand, Scissors, SquaresFour, Target, Warning } from '@phosphor-icons/react'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { useDevice } from '@/app/device'
import { Tip } from '@/ui/Tooltip'
import { toast } from '@/ui/Modal'
import { setPreview, useSlice } from '../engine/sliceStore'
import { plateObjects } from '../plate'
import { showPreview } from '../preview/command'
import { cancelSlice, runSlice } from '../slice/run'
import { profileNow } from '../slice/controller'
import { arrangeParts, autoOrientParts, centreParts, resetParts, setPose } from './ops'
import { bodyNames, plateProblems, usePlate, usePlateModel, useStage, type PlateTool } from './store'
import { usePlateActive, usePlateKeys } from './sync'
import { PrintSidebar } from './Sidebar'

/** What stops the slice (off the bed, too tall) and what only warns (parts that overlap: the slicer will say so if it matters). */
function useProblems(): { hard: string[]; soft: string[] } {
  const plate = usePlateModel()
  const geometry = useDoc((s) => s.geometry)
  const names = useDoc((s) => s.bodyNames)
  return useMemo(() => {
    const n = bodyNames()
    return {
      hard: plateProblems(plate.list, n, plate.bed),
      soft: plate.overlaps.map(([a, b]) => `${n[a] ?? 'A part'} and ${n[b] ?? 'another part'} overlap. Move them apart, or press Arrange.`),
    }
  }, [plate, geometry, names])
}

function SliceButton({ problems, count }: { problems: string[]; count: number }) {
  const status = useSlice((s) => s.status)
  const progress = useSlice((s) => s.progress)
  const stale = useSlice((s) => s.stale)
  const download = useSlice((s) => s.download)
  const done = useSlice((s) => !!s.result)
  const busy = status === 'loading' || status === 'slicing'
  const compact = useDevice((d) => d.compact)
  const label = busy ? (download ? (compact ? 'Loading' : 'Getting the slicer') : status === 'loading' ? (compact ? 'Loading' : 'Getting ready') : `${compact ? '' : 'Slicing '}${Math.round(progress)}%`) : done && stale ? (compact ? 'Redo' : 'Re-slice') : compact ? 'Slice' : 'Slice plate'
  const bad = !busy && problems.length > 0
  const click = () => {
    if (busy) return cancelSlice()
    if (!count) return toast('There is nothing to slice yet: make a solid body first', 'info')
    if (bad) return toast(problems.join(' '), 'error')
    void runSlice()
  }
  return (
    <Tip label={busy ? 'Cancel slicing' : bad ? 'Cannot slice yet' : label} desc={busy ? 'Stops the slice that is running.' : bad ? problems[0] : 'Slice the plate here in the browser with the OrcaSlicer engine.'} side="bottom">
      <button
        type="button" className="ws-slice" data-testid="slice-plate" data-busy={busy} data-bad={bad} data-stale={done && stale} aria-disabled={!count && !busy}
        style={busy ? ({ ['--p' as string]: `${Math.max(4, progress)}%` } as React.CSSProperties) : undefined} onClick={click}
      >
        {busy ? <CircleNotch size={16} className="ws-spin" /> : bad ? <Warning size={16} weight="fill" /> : <Scissors size={16} weight="bold" />}
        <span>{label}</span>
      </button>
    </Tip>
  )
}

function TopBar({ problems, count }: { problems: string[]; count: number }) {
  const stage = useStage()
  const hasResult = useSlice((s) => !!s.result?.toolpaths?.extrusions.count)
  const ref = useRef<HTMLDivElement>(null)
  // the thumb slides under the active option (same behaviour as the app's other segmented controls)
  useEffect(() => {
    const el = ref.current
    const on = el?.querySelector<HTMLElement>("[aria-checked='true']")
    if (!el || !on) return
    el.style.setProperty('--thumb-x', `${on.offsetLeft}px`)
    el.style.setProperty('--thumb-w', `${on.offsetWidth}px`)
    el.style.setProperty('--thumb-o', '1')
  }, [stage, hasResult])
  const go = (s: 'prepare' | 'preview') => {
    if (s === 'preview') {
      if (!hasResult) return toast('Slice the plate first, then you can look through its layers', 'info')
      return showPreview()
    }
    setPreview(false)
  }
  return (
    <div className="ws-top glass" data-testid="print-topbar">
      <div className="seg ws-stage" role="radiogroup" ref={ref} aria-label="Stage">
        <button type="button" role="radio" aria-checked={stage === 'prepare'} data-testid="stage-prepare" onClick={() => go('prepare')}>Prepare</button>
        <button type="button" role="radio" aria-checked={stage === 'preview'} data-testid="stage-preview" data-ready={hasResult} onClick={() => go('preview')}>Preview</button>
      </div>
      <SliceButton problems={problems} count={count} />
    </div>
  )
}

const TOOLS: { id: PlateTool | 'orient' | 'arrange' | 'center' | 'reset'; label: string; key: string; desc: string; icon: typeof Target; mode?: boolean }[] = [
  { id: 'move', label: 'Move', key: 'M', desc: 'Slide the selected part on the bed. It stays on the plate: only X and Y change.', icon: ArrowsOutCardinal, mode: true },
  { id: 'rotate', label: 'Rotate', key: 'R', desc: 'Turn the selected part about any axis. It drops back onto the bed after every turn.', icon: ArrowsCounterClockwise, mode: true },
  { id: 'face', label: 'Lay on face', key: 'L', desc: 'Click a face of the part: it becomes the bottom that lies on the bed.', icon: ArrowFatLineDown, mode: true },
  { id: 'orient', label: 'Auto orient', key: 'O', desc: 'Find the way up that needs the least support (for the selected part, or all of them) and turn it that way.', icon: MagicWand },
  { id: 'arrange', label: 'Arrange', key: 'A', desc: 'Lay all parts out on the bed, nearest the middle first.', icon: SquaresFour },
  { id: 'center', label: 'Center', key: 'C', desc: 'Put the selected part (or the whole group) in the middle of the bed.', icon: Target },
  { id: 'reset', label: 'Reset', key: '', desc: 'Back to the CAD orientation, standing where it is.', icon: ArrowCounterClockwise },
]

function ObjectToolbar() {
  const tool = usePlate((s) => s.tool)
  const busy = usePlate((s) => s.busy)
  const assembly = useDoc((s) => s.assembly.occurrences.length > 0)
  const run = (id: (typeof TOOLS)[number]['id']) => {
    if (id === 'move' || id === 'rotate' || id === 'face') return usePlate.setState({ tool: id })
    if (id === 'orient') return void autoOrientParts()
    if (id === 'arrange') return void arrangeParts()
    if (id === 'center') return void centreParts()
    return void resetParts()
  }
  return (
    <div className="ws-tools glass" role="toolbar" aria-label="Object tools" data-testid="object-toolbar">
      {TOOLS.map((t, i) => (
        <span key={t.id} className="ws-tool-wrap">
          {i === 3 && <span className="ws-sep" />}
          {i === 6 && <span className="ws-sep" />}
          <Tip label={t.label} shortcut={t.key || undefined} desc={t.desc} side="bottom">
            <button type="button" className="ws-tool" data-testid={`tool-${t.id}`} data-active={t.mode ? tool === t.id : undefined} disabled={assembly || (!!busy && !t.mode)} aria-label={t.label} onClick={() => run(t.id)}>
              {busy && t.id === 'orient' ? <CircleNotch size={18} className="ws-spin" /> : <t.icon size={18} />}
            </button>
          </Tip>
        </span>
      ))}
    </div>
  )
}

const fmt = (n: number) => String(+n.toFixed(2))

function NumField({ label, value, onCommit, unit }: { label: string; value: number; onCommit: (v: number) => void; unit?: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const v = parseFloat(draft)
    setDraft(null)
    if (isFinite(v) && Math.abs(v - value) > 1e-6) onCommit(v)
  }
  return (
    <label className="ws-num">
      <span>{label}</span>
      <input
        type="text" inputMode="decimal" value={draft ?? fmt(value)} data-testid={`pose-${label}`}
        onFocus={(e) => e.currentTarget.select()} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur() } }}
      />
      {unit && <i>{unit}</i>}
    </label>
  )
}

function Readout() {
  const plate = usePlateModel()
  const selection = useUi((s) => s.selection)
  const names = useDoc((s) => s.bodyNames)
  const part = plate.list.find((p) => selection.some((r) => r.id === p.id))
  const body = part && plate.bodies.find((b) => b.id === part.id)
  if (!part || !body) return null
  const { x, y, r } = part.entry
  const name = names[part.id] ?? body.name
  return (
    <div className="ws-read glass" data-testid="part-readout" data-status={part.status}>
      <div className="ws-read-name"><b>{name}</b><span className="num">{part.size.map((v) => +v.toFixed(1)).join(' x ')} mm</span></div>
      <div className="ws-read-row">
        <span className="ws-read-group"><NumField label="X" value={x} unit="mm" onCommit={(v) => void setPose(part.id, { x: v })} /><NumField label="Y" value={y} unit="mm" onCommit={(v) => void setPose(part.id, { y: v })} /></span>
        <span className="ws-read-group"><NumField label="Rx" value={r[0]} unit="deg" onCommit={(v) => void setPose(part.id, { r: [v, r[1], r[2]] }, 'Rotate part')} /><NumField label="Ry" value={r[1]} unit="deg" onCommit={(v) => void setPose(part.id, { r: [r[0], v, r[2]] }, 'Rotate part')} /><NumField label="Rz" value={r[2]} unit="deg" onCommit={(v) => void setPose(part.id, { r: [r[0], r[1], v] }, 'Rotate part')} /></span>
      </div>
    </div>
  )
}

/** Phone: the sidebar as a bottom sheet you pull up. */
function Sheet() {
  const [open, setOpen] = useState(false)
  const profile = profileNow()
  return (
    <div className="ws-sheet" data-open={open} data-testid="print-sheet">
      <button type="button" className="ws-sheet-grip" aria-expanded={open} aria-label={open ? 'Hide the print setup' : 'Show the print setup'} onClick={() => setOpen(!open)}>
        <span className="ws-grip" />
        <span className="ws-sheet-sum">{profile.machine.replace(/ nozzle$/, '')}</span>
        <CaretUp size={14} weight="bold" className="ws-caret" />
      </button>
      <div className="ws-sheet-body"><PrintSidebar sheet /></div>
    </div>
  )
}

export function WorkspaceHud() {
  const active = usePlateActive()
  const stage = useStage()
  const compact = useDevice((d) => d.compact)
  const { hard: problems, soft } = useProblems()
  const notes = [...problems, ...soft]
  const geometry = useDoc((s) => s.geometry)
  const hidden = useUi((s) => s.hiddenIds)
  const count = useMemo(() => plateObjects().length, [geometry, hidden]) // eslint-disable-line react-hooks/exhaustive-deps
  usePlateKeys(active)
  // picking a part is whole-body picking
  useEffect(() => { useUi.getState().setSelectionFilter('body') }, [])
  const showWarn = stage === 'prepare' && notes.length > 0
  return (
    <div className="ws-hud" data-testid="print-workspace" data-stage={stage}>
      <TopBar problems={problems} count={count} />
      {stage === 'prepare' && active && <ObjectToolbar />}
      {showWarn && (
        <div className="ws-warn-pill glass" data-testid="plate-warning" role="status">
          <Warning size={15} weight="fill" /><span>{notes[0]}</span>{notes.length > 1 && <em>+{notes.length - 1} more</em>}
        </div>
      )}
      {stage === 'prepare' && active && <Readout />}
      {compact && stage === 'prepare' && <Sheet />}
    </div>
  )
}
