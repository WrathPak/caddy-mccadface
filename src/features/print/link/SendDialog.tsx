/** Send to printer: pick the printer, match each filament of the slice to a tray, set the options, upload and start the job. */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle, CircleNotch, PaperPlaneTilt, Warning, X } from '@phosphor-icons/react'
import { Checkbox } from '@/ui/Toggle'
import { useSlice } from '../engine/sliceStore'
import { buildExport } from '../slice/exportGcode'
import { cancelSend, clearSend, retryLink, sendFile, setPanel, setSendOpen } from './client'
import { autoMap, defaultPrinter, mappingArray, modelMatches, plainLinkError, sameType, trayLabel, trayList, type Need } from './logic'
import { useLink } from './store'
import './link.css'

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

const STAGE: Record<string, string> = { receiving: 'Preparing the file', uploading: 'Uploading to the printer', starting: 'Starting the print', done: 'Sent. The print is starting.', cancelled: 'Cancelled' }

export function SendDialog() {
  const { sendOpen, conn, printers, statuses, send } = useLink()
  const { snapshot, result, filamentColors } = useSlice()
  const machine = snapshot?.profile.machine ?? ''
  const [pid, setPid] = useState('')
  const [assign, setAssign] = useState<Record<number, number>>({})
  const [opt, setOpt] = useState({ bedLeveling: true, flowCali: true, timelapse: false })
  const [err, setErr] = useState('')

  const needs: Need[] = useMemo(() => (snapshot?.usage ?? []).map((u) => ({
    slot: u.slot,
    color: filamentColors[u.slot - 1] ?? '#FFFFFF',
    type: first(snapshot?.resolved.filaments[u.slot - 1]?.filament_type) || 'PLA',
  })), [snapshot, filamentColors])

  // a fresh open starts clean and picks the printer that matches the slice
  useEffect(() => { if (sendOpen) { setErr(''); setPid(''); useLink.setState({ send: null }) } }, [sendOpen])
  useEffect(() => { if (sendOpen && !printers.some((p) => p.id === pid)) setPid(defaultPrinter(printers, machine)?.id ?? '') }, [sendOpen, printers, pid, machine])

  const printer = printers.find((p) => p.id === pid) ?? null
  const status = pid ? statuses[pid] : undefined
  const trays = trayList(status)
  const hasAms = !!status && (status.ams.units.length > 0)
  // match again when the printer or its loaded filaments change; edits are kept while neither does
  const trayKey = trays.map((t) => `${t.id}${t.type}${t.color}${t.empty}`).join()
  useEffect(() => { setAssign(autoMap(needs, trays)) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pid, trayKey, needs])

  if (!sendOpen) return null
  const busy = !!send && (send.stage === 'receiving' || send.stage === 'uploading' || send.stage === 'starting')
  const done = send?.stage === 'done'
  const close = () => { if (busy) return; setSendOpen(false); if (done) clearSend() }
  const mismatch = printer && !modelMatches(printer, machine)

  const go = async () => {
    if (!snapshot || !result || !printer) return
    setErr('')
    let built
    try { built = await buildExport(snapshot, result.gcode) } catch (e) { return setErr(`Could not build the file: ${e instanceof Error ? e.message : String(e)}`) }
    const map = hasAms ? mappingArray(assign, needs) : []
    await sendFile({ printerId: printer.id, fileName: built.name, useAms: hasAms, amsMapping: map, bedLeveling: opt.bedLeveling, flowCali: opt.flowCali, timelapse: opt.timelapse }, built.bytes)
  }

  const pct = send && send.total > 0 ? Math.round((send.sent / send.total) * 100) : 0

  return createPortal(
    <div className="sl-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }} data-testid="send-scrim">
      <div className="lk-send" role="dialog" aria-modal="true" aria-label="Send to printer" data-testid="send-dialog" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close() }}>
        <header className="lk-send-h">
          <h2><PaperPlaneTilt size={18} weight="duotone" /> Send to printer</h2>
          <button type="button" className="sl-close" aria-label="Close" data-testid="send-close" onClick={close}><X size={16} /></button>
        </header>
        <div className="lk-send-b">
          {conn !== 'ready' && (
            <div className="lk-note" data-testid="send-noconn">
              <Warning size={14} weight="fill" />
              <span>{conn === 'pairing' ? 'CADdy Link needs pairing first.' : conn === 'connecting' ? 'Connecting to CADdy Link ...' : "CADdy Link isn't running."}</span>
              {conn === 'pairing' ? <button type="button" className="btn" onClick={() => { setPanel(true); setSendOpen(false) }}>Pair</button>
                : conn !== 'connecting' && <button type="button" className="btn" onClick={() => { setPanel(true); setSendOpen(false) }}>Help</button>}
              {conn === 'off' && <button type="button" className="btn" onClick={retryLink}>Try again</button>}
            </div>
          )}
          {conn === 'ready' && printers.length === 0 && (
            <div className="lk-note" data-testid="send-noprinters"><Warning size={14} weight="fill" /><span>No printers added yet.</span><button type="button" className="btn" onClick={() => { setPanel(true); setSendOpen(false) }}>Add one</button></div>
          )}
          {conn === 'ready' && printer && (
            <>
              <label className="lk-fld">
                <span>Printer</span>
                <select className="sl-input" data-testid="send-printer" value={pid} disabled={busy || done} onChange={(e) => setPid(e.target.value)}>
                  {printers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.modelLabel.replace('Bambu Lab ', '')})</option>)}
                </select>
              </label>
              {mismatch && <div className="lk-note warn" data-testid="send-mismatch"><Warning size={14} weight="fill" /><span>This plate was sliced for {machine.replace(/ nozzle$/, '')}, not for the {printer.modelLabel}. The print may be refused or come out wrong. Slice it for this printer to be safe.</span></div>}
              {!status?.online && <div className="lk-note warn" data-testid="send-offline"><Warning size={14} weight="fill" /><span>{status?.problem ? plainLinkError(status.problem.code, status.problem.message) : 'This printer is not reporting yet.'}</span></div>}
              {status?.online && status.state !== 'idle' && status.state !== 'finish' && status.state !== 'failed' && (
                <div className="lk-note warn" data-testid="send-busy"><Warning size={14} weight="fill" /><span>The printer is busy ({status.gcodeState.toLowerCase()}). Wait for it to finish.</span></div>
              )}

              <div className="lk-sec">Filament</div>
              <div className="lk-map" data-testid="send-map">
                {needs.map((n) => {
                  const t = trays.find((x) => x.id === assign[n.slot])
                  const wrongType = !!t && !t.empty && !sameType(t.type, n.type)
                  return (
                    <div className="lk-map-r" key={n.slot} data-testid={`map-row-${n.slot}`}>
                      <div className="lk-map-f"><span className="sw chip" style={{ background: n.color }} /><span>{needs.length > 1 ? `Filament ${n.slot}` : 'Filament'}</span><i>{n.type}</i></div>
                      {hasAms || trays.length ? (
                        <div className="lk-map-t">
                          <span className="sw chip" style={{ background: t && !t.empty ? t.color ?? 'var(--text-faint)' : 'transparent' }} />
                          <select className="sl-input" data-testid={`map-select-${n.slot}`} value={assign[n.slot] ?? -1} disabled={busy || done} onChange={(e) => setAssign({ ...assign, [n.slot]: +e.target.value })}>
                            <option value={-1}>Choose a tray</option>
                            {trays.map((x) => <option key={x.id} value={x.id}>{trayLabel(x)}: {x.empty ? 'empty' : `${x.type || 'filament'}${x.remain >= 0 ? `, ${x.remain}%` : ''}`}</option>)}
                          </select>
                        </div>
                      ) : <div className="lk-map-t lk-dim">Loaded on the printer's spool holder</div>}
                      {wrongType && <div className="lk-map-w" data-testid={`map-warn-${n.slot}`}><Warning size={12} weight="fill" /> The tray holds {t!.type || 'another filament'}, the slice uses {n.type}.</div>}
                      {t?.empty && <div className="lk-map-w" data-testid={`map-warn-${n.slot}`}><Warning size={12} weight="fill" /> That tray is empty.</div>}
                      {hasAms && (assign[n.slot] ?? -1) < 0 && <div className="lk-map-w"><Warning size={12} weight="fill" /> No tray chosen. The printer will pause and ask.</div>}
                    </div>
                  )
                })}
              </div>

              <div className="lk-sec">Before printing</div>
              <div className="lk-opts">
                <label><Checkbox checked={opt.bedLeveling} onChange={(v) => setOpt({ ...opt, bedLeveling: v })} ariaLabel="Bed leveling" /> Bed leveling</label>
                <label><Checkbox checked={opt.flowCali} onChange={(v) => setOpt({ ...opt, flowCali: v })} ariaLabel="Flow calibration" /> Flow calibration</label>
                <label><Checkbox checked={opt.timelapse} onChange={(v) => setOpt({ ...opt, timelapse: v })} ariaLabel="Timelapse" /> Timelapse</label>
              </div>
            </>
          )}

          {send && (
            <div className="lk-prog" data-testid="send-progress" data-stage={send.stage}>
              {send.stage === 'error'
                ? <div className="lk-err"><Warning size={13} weight="fill" /> {plainLinkError(send.code ?? '', send.message ?? 'The send failed')}</div>
                : (
                  <>
                    <div className="sc-bar" role="progressbar" aria-valuenow={pct}><div style={{ width: `${done ? 100 : Math.max(3, pct)}%` }} /></div>
                    <div className="sc-line">{done ? <CheckCircle size={14} weight="fill" className="lk-ok" /> : <CircleNotch size={13} className="sc-spin" />}<span>{STAGE[send.stage] ?? send.stage}{send.stage === 'uploading' && send.total ? `, ${pct}%` : ''}</span></div>
                  </>
                )}
            </div>
          )}
          {err && <div className="lk-err" data-testid="send-error"><Warning size={13} weight="fill" /> {err}</div>}
        </div>
        <footer className="lk-send-f">
          {done
            ? <button type="button" className="btn primary" data-testid="send-view" onClick={() => { setPanel(true); clearSend(); setSendOpen(false) }}>View on printer</button>
            : (
              <>
                <button type="button" className="btn" data-testid="send-cancel" onClick={() => (busy ? void cancelSend() : close())}>{busy ? 'Cancel send' : 'Cancel'}</button>
                <button type="button" className="btn primary" data-testid="send-go" disabled={busy || conn !== 'ready' || !printer || !status?.online} onClick={() => void go()}><PaperPlaneTilt size={14} /> Send</button>
              </>
            )}
        </footer>
      </div>
    </div>,
    document.body,
  )
}
