import { useMemo, useState } from 'react'
import { ClockCounterClockwise } from '@phosphor-icons/react'
import { useHistory } from './store'
import { compareVersions, previewVersion, pruneNow, restoreVersion } from './service'
import { shown, type DocDiff } from './diff'
import { toast } from '@/ui/Modal'
import '@/app/platform.css'

const when = (t: number) => {
  const d = new Date(t)
  const today = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === today.toDateString() ? `Today ${time}` : `${d.toLocaleDateString()} ${time}`
}
const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)

function DiffView({ a, b, diff }: { a: number; b: number; diff: DocDiff }) {
  return (
    <div className="pf-diff" data-testid="history-diff">
      <div className="pf-sub">Version {a} to version {b}</div>
      {diff.same && <div className="pf-sub">No differences.</div>}
      {diff.features.map((f) => (
        <div key={f.kind + f.id}>
          <div className={'line ' + f.kind}>
            <span className="tag">{f.kind === 'added' ? '+' : f.kind === 'removed' ? '-' : '~'}</span>
            <span>{f.name}</span>
            <span className="pf-sub">{f.kind === 'moved' ? 'moved in the timeline' : f.kind}</span>
          </div>
          {f.changes.map((c) => (
            <div key={c.key} className="sub">{c.key}: {shown(c.from)} {'->'} {shown(c.to)}</div>
          ))}
        </div>
      ))}
      {diff.parameters.map((p) => (
        <div key={p.key} className="line changed"><span className="tag">~</span><span>Parameter {p.key}</span><span className="pf-sub">{shown(p.from)} {'->'} {shown(p.to)}</span></div>
      ))}
      {diff.other.map((p) => (
        <div key={p.key} className="line changed"><span className="tag">~</span><span>{p.key}</span><span className="pf-sub">{shown(p.from)} {'->'} {shown(p.to)}</span></div>
      ))}
    </div>
  )
}

export function HistoryPanel() {
  const { versions, bytes, settings, previewing, setSettings } = useHistory()
  const [picked, setPicked] = useState<number[]>([])
  const [diff, setDiff] = useState<{ a: number; b: number; diff: DocDiff } | null>(null)
  const rows = useMemo(() => [...versions].reverse(), [versions])

  const toggle = (n: number) => {
    setDiff(null)
    setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p.slice(-1), n]))
  }
  const one = picked.length === 1 ? picked[0] : null

  return (
    <div className="pf-panel" data-testid="history-panel">
      <div className="pf-head">
        <ClockCounterClockwise size={14} />
        <b className="grow">History</b>
        <span className="pf-sub" data-testid="history-size">{versions.length} {versions.length === 1 ? 'version' : 'versions'}, {size(bytes)}</span>
      </div>
      <div className="pf-scroll">
        {rows.length === 0 && <div className="pf-empty">Nothing here yet. Each time you save, a version of the project is kept inside the file, so you can look back at it, compare it with another one or go back to it.</div>}
        {rows.map((v) => (
          <div key={v.n} className="pf-item" data-testid="history-row" data-version={v.n} data-selected={picked.includes(v.n) || previewing === v.n} onClick={() => toggle(v.n)}>
            <input type="checkbox" aria-label={`Select version ${v.n}`} checked={picked.includes(v.n)} onChange={() => toggle(v.n)} onClick={(e) => e.stopPropagation()} />
            <span className="badge">v{v.n}</span>
            <span className="main">
              <span className="title">{v.note || 'Saved'}</span>
              <span className="meta">{when(v.t)} - {v.features} {v.features === 1 ? 'feature' : 'features'}{previewing === v.n ? ' - on show' : ''}</span>
            </span>
          </div>
        ))}
      </div>
      {diff && <DiffView a={diff.a} b={diff.b} diff={diff.diff} />}
      <div className="pf-foot">
        <div className="pf-actions">
          <button type="button" className="btn" disabled={one === null} onClick={() => one !== null && void previewVersion(one)}>Preview</button>
          <button type="button" className="btn" disabled={one === null} onClick={() => one !== null && void restoreVersion(one)}>Restore</button>
          <button
            type="button"
            className="btn"
            disabled={picked.length !== 2}
            onClick={() => {
              const [x, y] = [...picked].sort((p, q) => p - q)
              const d = compareVersions(x, y)
              if (d) setDiff({ a: x, b: y, diff: d })
              else toast('Those versions cannot be compared', 'error')
            }}
          >
            Compare
          </button>
        </div>
        <div className="pf-row-inputs" title="The oldest versions are dropped when a save would go over either limit">
          Keep
          <label className="inp"><input aria-label="Most versions to keep" type="number" min={1} value={settings.maxVersions} onChange={(e) => setSettings({ maxVersions: Number(e.target.value) })} /></label>
          versions, under
          <label className="inp"><input aria-label="Most megabytes of history" type="number" min={0} value={settings.maxMB} onChange={(e) => setSettings({ maxMB: Number(e.target.value) })} /></label>
          MB
        </div>
        <div className="pf-actions">
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const n = await pruneNow()
              setPicked([]); setDiff(null)
              toast(n ? `Dropped ${n} older ${n === 1 ? 'version' : 'versions'}. The file shrinks when you save.` : 'Nothing to drop')
            }}
          >
            Prune now
          </button>
        </div>
      </div>
    </div>
  )
}
