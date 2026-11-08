/** The result card in the viewport: engine download, slice progress with Cancel, then the print time, filament and warnings. */
import { useState } from 'react'
import { CircleNotch, DownloadSimple, Gear, PaperPlaneTilt, WarningCircle, X, ArrowClockwise } from '@phosphor-icons/react'
import { useSlice } from '../engine/sliceStore'
import { Tip } from '@/ui/Tooltip'
import { setSendOpen } from '../link/client'
import { exportGcode } from './exportGcode'
import { cancelSlice, plainWarning, runSlice } from './run'
import { useSlicer } from './store'

const mb = (n: number) => (n / 1048576).toFixed(1)
const f1 = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1))

export function SliceCard({ compact = false }: { compact?: boolean }) {
  const s = useSlice()
  const [hidden, setHidden] = useState(false)
  const [seen, setSeen] = useState(s.result)
  if (seen !== s.result) { setSeen(s.result); setHidden(false) }
  if (s.status === 'idle' || (hidden && s.status === 'done')) return null
  const busy = s.status === 'loading' || s.status === 'slicing'
  const snap = s.snapshot
  const r = s.result
  return (
    <div className="print-card slice-card" data-testid="slice-card" data-status={s.status} data-stale={s.stale}>
      <div className="print-card-head">
        <span>{busy ? (s.download ? 'Getting the slicer' : s.status === 'loading' ? 'Getting ready' : 'Slicing') : s.status === 'error' ? 'Could not slice' : 'Sliced'}{s.stale && s.status === 'done' && <em className="sc-stale" data-testid="stale-badge">out of date</em>}</span>
        {!busy && <Tip label="Close" side="top"><button type="button" aria-label="Close" onClick={() => setHidden(true)}><X size={12} /></button></Tip>}
      </div>
      {busy && (
        <>
          <div className="sc-bar" role="progressbar" aria-valuenow={s.progress}><div style={{ width: `${Math.max(3, s.progress)}%` }} /></div>
          <div className="sc-line" data-testid="slice-progress">
            <CircleNotch size={13} className="sc-spin" />
            <span>{s.download ? `Downloading the slicer once, ${mb(s.download.loaded)} of ${mb(s.download.total)} MB. It is kept for next time.` : s.message || 'Working'}</span>
          </div>
          <div className="sc-actions"><button type="button" className="btn" data-testid="slice-cancel" onClick={cancelSlice}>Cancel</button></div>
        </>
      )}
      {s.status === 'error' && (
        <>
          <div className="sc-line err" data-testid="slice-error"><WarningCircle size={14} weight="fill" /><span>{s.message}</span></div>
          <div className="sc-actions">
            <button type="button" className="btn" onClick={() => useSlicer.getState().openSheet()}><Gear size={14} /> Settings</button>
            <button type="button" className="btn primary" onClick={() => void runSlice()}>Try again</button>
          </div>
        </>
      )}
      {s.status === 'done' && r && snap && compact && (
        <div className="sc-compact">
          <div className="sc-compact-main">
            <b data-testid="print-time">{snap.timeKnown ? r.stats.printTimeText ?? 'unknown' : 'no time'}</b>
            <i />
            <b>{r.stats.filamentG ? `${f1(r.stats.filamentG)} g` : '-'}</b>
          </div>
          <Tip label="Export G-code" side="top"><button type="button" className="btn" data-testid="export-gcode" aria-label="Export G-code" onClick={() => void exportGcode()}><DownloadSimple size={14} /></button></Tip>
          {snap.profile.vendor === 'BBL' && <Tip label="Send to printer" side="top"><button type="button" className="btn" data-testid="send-to-printer" aria-label="Send to printer" onClick={() => setSendOpen(true)}><PaperPlaneTilt size={14} /></button></Tip>}
          {s.stale && <Tip label="Slice again" side="top"><button type="button" className="btn" data-testid="reslice" aria-label="Slice again" onClick={() => void runSlice()}><ArrowClockwise size={14} /></button></Tip>}
        </div>
      )}
      {s.status === 'done' && r && snap && !compact && (
        <>
          <div className="sc-stats">
            <div><span>Print time</span><b data-testid="print-time">{snap.timeKnown ? r.stats.printTimeText ?? 'unknown' : 'not available'}</b></div>
            <div><span>Layers</span><b data-testid="layer-count">{r.stats.layers ?? r.toolpaths?.layerCount ?? 0}</b></div>
            <div><span>Filament</span><b>{r.stats.filamentG ? `${f1(r.stats.filamentG)} g` : '-'}</b></div>
            {!!r.stats.filamentCost && <div><span>Cost</span><b>{r.stats.filamentCost.toFixed(2)}</b></div>}
          </div>
          {!snap.timeKnown && <p className="sc-note" data-testid="time-note">The time estimate is not available for this printer yet.</p>}
          <div className="sc-fil" data-testid="filament-usage">
            {snap.usage.map((u) => (
              <div key={u.slot}>
                <span className="sw chip" style={{ background: s.filamentColors[u.slot - 1] }} />
                <span>{snap.usage.length > 1 ? `Filament ${u.slot}` : snap.resolved.filamentNames[0]}</span>
                <b>{(u.mm / 1000).toFixed(2)} m</b><b>{f1(u.g)} g</b>{u.cost > 0 && <b>{u.cost.toFixed(2)}</b>}
              </div>
            ))}
          </div>
          {!snap.plate.fits && <div className="sc-line warn"><WarningCircle size={14} weight="fill" /><span>Some parts are larger than the plate.</span></div>}
          {r.warnings.map((w, i) => <div key={i} className="sc-line warn" data-testid="slice-warning"><WarningCircle size={14} weight="fill" /><span>{plainWarning(w)}</span></div>)}
          <div className="sc-actions">
            <button type="button" className="btn primary" data-testid="export-gcode" onClick={() => void exportGcode()}><DownloadSimple size={14} /> Export G-code</button>
            {snap.profile.vendor === 'BBL' && <button type="button" className="btn" data-testid="send-to-printer" onClick={() => setSendOpen(true)}><PaperPlaneTilt size={14} /> Send to printer</button>}
            <Tip label={s.stale ? 'Slice again' : 'Settings'} side="top">
              {s.stale
                ? <button type="button" className="btn" data-testid="reslice" aria-label="Slice again" onClick={() => void runSlice()}><ArrowClockwise size={14} /></button>
                : <button type="button" className="btn" aria-label="Settings" onClick={() => useSlicer.getState().openSheet()}><Gear size={14} /></button>}
            </Tip>
          </div>
        </>
      )}
    </div>
  )
}
