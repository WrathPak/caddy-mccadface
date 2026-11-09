/** Send to printer: pick the printer, match each filament of the slice to a tray (Bambu), set the options, upload and start the job. */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle, CircleNotch, Info, PaperPlaneTilt, ShieldWarning, Warning, X } from '@phosphor-icons/react'
import { Checkbox } from '@/ui/Toggle'
import { loadProfileSet } from '../engine/profiles'
import { useSlice } from '../engine/sliceStore'
import { buildExport } from '../slice/exportGcode'
import { cancelSend, clearSend, printerHttp, retryLink, sendFile, setPanel, setSendOpen, trustCertificate } from './client'
import { autoMap, defaultPrinter, hasPresetFor, mappingArray, modelMatches, plainLinkError, prettyFingerprint, printerModel, printersForVendor, sameType, trayLabel, trayList, type Need } from './logic'
import { useLink } from './store'
import './link.css'

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

const STAGE: Record<string, string> = { receiving: 'Preparing the file', uploading: 'Uploading to the printer', starting: 'Starting the print', done: 'Sent. The print is starting.', cancelled: 'Cancelled' }

interface Storage { path: string; name: string; free: number }

const gb = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`)

/** The names of the Bambu machine presets in the profile set, to tell whether a printer model can be sliced for. */
function useBambuMachines(): string[] | null {
  const [names, setNames] = useState<string[] | null>(null)
  useEffect(() => {
    let live = true
    void loadProfileSet().then((set) => { if (live) setNames(set.index.vendors.find((v) => v.id === 'BBL')?.printers.map((p) => p.name) ?? []) }).catch(() => { /* no profiles: no note */ })
    return () => { live = false }
  }, [])
  return names
}

export function SendDialog() {
  const { sendOpen, conn, printers, statuses, send } = useLink()
  const { snapshot, result, filamentColors } = useSlice()
  const machine = snapshot?.profile.machine ?? ''
  const vendor = snapshot?.profile.vendor ?? 'BBL'
  const [pid, setPid] = useState('')
  const [assign, setAssign] = useState<Record<number, number>>({})
  const [opt, setOpt] = useState({ bedLeveling: true, flowCali: true, timelapse: false })
  const [err, setErr] = useState('')
  const [storages, setStorages] = useState<Storage[] | null>(null)
  const [storage, setStorage] = useState('')
  const [trusted, setTrusted] = useState(false)
  const machines = useBambuMachines()

  const needs: Need[] = useMemo(() => (snapshot?.usage ?? []).map((u) => ({
    slot: u.slot,
    color: filamentColors[u.slot - 1] ?? '#FFFFFF',
    type: first(snapshot?.resolved.filaments[u.slot - 1]?.filament_type) || 'PLA',
  })), [snapshot, filamentColors])

  const candidates = useMemo(() => printersForVendor(printers, vendor), [printers, vendor])
  // a fresh open starts clean and picks the printer that matches the slice
  useEffect(() => { if (sendOpen) { setErr(''); setPid(''); setTrusted(false); useLink.setState({ send: null }) } }, [sendOpen])
  useEffect(() => { if (sendOpen && !candidates.some((p) => p.id === pid)) setPid(defaultPrinter(printers, machine, vendor)?.id ?? '') }, [sendOpen, candidates, printers, pid, machine, vendor])

  const printer = candidates.find((p) => p.id === pid) ?? null
  const status = pid ? statuses[pid] : undefined
  const bambu = printer?.kind === 'bambu'
  const trays = bambu ? trayList(status) : []
  const hasAms = bambu && !!status && (status.ams.units.length > 0)
  // match again when the printer or its loaded filaments change; edits are kept while neither does
  const trayKey = trays.map((t) => `${t.id}${t.type}${t.color}${t.empty}`).join()
  useEffect(() => { setAssign(autoMap(needs, trays)) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pid, trayKey, needs])

  // PrusaLink: where the file can go, asked of the printer through the helper
  // (only once the helper connection is up: closing the panel let it go, and opening this dialog connects it again)
  const prusaOnline = conn === 'ready' && printer?.kind === 'prusa' && !!status?.online && !status.problem
  useEffect(() => {
    setStorages(null); setStorage('')
    if (!sendOpen || !printer || !prusaOnline) return
    let live = true
    void printerHttp(printer.id, '/api/v1/storage').then((r) => {
      if (!live || r.status !== 200 || !r.body) return
      const list = ((JSON.parse(r.body) as { storage_list?: { path?: string; name?: string; available?: boolean; read_only?: boolean; free_space?: number }[] }).storage_list ?? [])
        .filter((x) => x.available && !x.read_only && x.path)
        .map((x) => ({ path: x.path!, name: x.name || x.path!, free: x.free_space ?? 0 }))
      setStorages(list)
      setStorage(list[0]?.path ?? '')
    }).catch(() => { if (live) setStorages([]) })
    return () => { live = false }
  }, [sendOpen, printer?.id, prusaOnline]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!sendOpen) return null
  const sending = !!send && (send.stage === 'receiving' || send.stage === 'uploading' || send.stage === 'starting')
  const done = send?.stage === 'done'
  const close = () => { if (sending) return; setSendOpen(false); if (done) clearSend() }
  const mismatch = bambu && printer && !modelMatches(printer, machine)
  const noPreset = bambu && printer && machines && !hasPresetFor(printer.modelLabel, machines)

  const go = async () => {
    if (!snapshot || !result || !printer) return
    setErr('')
    let built
    try { built = await buildExport(snapshot, result.gcode) } catch (e) { return setErr(`Could not build the file: ${e instanceof Error ? e.message : String(e)}`) }
    const map = hasAms ? mappingArray(assign, needs) : []
    await sendFile({ printerId: printer.id, fileName: built.name, useAms: hasAms, amsMapping: map, bedLeveling: opt.bedLeveling, flowCali: opt.flowCali, timelapse: opt.timelapse, storage: storage || undefined }, built.bytes)
  }
  const trust = async () => {
    if (!printer || !send?.newFingerprint) return
    try { await trustCertificate(printer.id, send.newFingerprint, bambu ? 'ftp' : 'http'); setTrusted(true); useLink.setState({ send: null }) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  const pct = send && send.total > 0 ? Math.round((send.sent / send.total) * 100) : 0
  const idle = !status || ['idle', 'finish', 'failed', 'stopped'].includes(status.state)
  const noneMatch = conn === 'ready' && printers.length > 0 && candidates.length === 0

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
          {noneMatch && (
            <div className="lk-note" data-testid="send-nomatch">
              <Warning size={14} weight="fill" />
              <span>This plate was sliced for {machine.replace(/ nozzle$/, '')}, which goes to {vendor === 'BBL' ? 'a Bambu Lab printer' : vendor === 'Prusa' ? 'a Prusa printer (PrusaLink)' : 'a Klipper (Moonraker) or OctoPrint printer'}. None of your added printers is one.</span>
              <button type="button" className="btn" onClick={() => { setPanel(true); setSendOpen(false) }}>Add one</button>
            </div>
          )}
          {conn === 'ready' && printer && (
            <>
              <label className="lk-fld">
                <span>Printer</span>
                <select className="sl-input" data-testid="send-printer" value={pid} disabled={sending || done} onChange={(e) => setPid(e.target.value)}>
                  {candidates.map((p) => <option key={p.id} value={p.id}>{p.name} ({printerModel(p)})</option>)}
                </select>
              </label>
              {mismatch && <div className="lk-note warn" data-testid="send-mismatch"><Warning size={14} weight="fill" /><span>This plate was sliced for {machine.replace(/ nozzle$/, '')}, not for the {printer.modelLabel}. The print may be refused or come out wrong. Slice it for this printer to be safe.</span></div>}
              {noPreset && <div className="lk-note warn" data-testid="send-nopreset"><Warning size={14} weight="fill" /><span>There is no slicing profile for the {printerModel(printer)} in this version of CADdy McCADFace, so a plate cannot be sliced for it yet. Sending this one may be refused or come out wrong.</span></div>}
              {!bambu && <div className="lk-note" data-testid="send-kind"><Info size={14} weight="fill" /><span>This G-code is for {machine.replace(/ nozzle$/, '')}. Make sure {printer.name} is that printer.</span></div>}
              {!status?.online && <div className="lk-note warn" data-testid="send-offline"><Warning size={14} weight="fill" /><span>{status?.problem ? plainLinkError(status.problem.code, status.problem.message) : 'This printer is not reporting yet.'}</span></div>}
              {status?.online && !idle && (
                <div className="lk-note warn" data-testid="send-busy"><Warning size={14} weight="fill" /><span>The printer is busy ({(status.gcodeState || status.state).toLowerCase()}). Wait for it to finish.</span></div>
              )}

              {bambu && (
                <>
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
                              <select className="sl-input" data-testid={`map-select-${n.slot}`} value={assign[n.slot] ?? -1} disabled={sending || done} onChange={(e) => setAssign({ ...assign, [n.slot]: +e.target.value })}>
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

              {printer.kind === 'prusa' && storages && storages.length > 0 && (
                <label className="lk-fld">
                  <span>Save the file to</span>
                  <select className="sl-input" data-testid="send-storage" value={storage} disabled={sending || done} onChange={(e) => setStorage(e.target.value)}>
                    {storages.map((x) => <option key={x.path} value={x.path}>{x.name}{x.free ? `, ${gb(x.free)} free` : ''}</option>)}
                  </select>
                </label>
              )}
              {printer.kind === 'prusa' && storages && storages.length === 0 && prusaOnline && (
                <div className="lk-note warn" data-testid="send-nostorage"><Warning size={14} weight="fill" /><span>The printer reports no storage that is ready. Insert a USB drive, then open this again.</span></div>
              )}
              {!bambu && <p className="lk-hint">The file is sent as plain G-code and starts printing as soon as it arrives.</p>}
            </>
          )}

          {send && (
            <div className="lk-prog" data-testid="send-progress" data-stage={send.stage}>
              {send.stage === 'error'
                ? (
                  <>
                    <div className="lk-err"><Warning size={13} weight="fill" /> <span>{plainLinkError(send.code ?? '', send.message ?? 'The send failed')}</span></div>
                    {send.code === 'cert_changed' && send.newFingerprint && (
                      <div className="lk-confirm lk-cert-box" data-testid="send-cert">
                        <div className="lk-fp"><span>Saved</span><code>{send.oldFingerprint ? prettyFingerprint(send.oldFingerprint) : 'not known'}</code></div>
                        <div className="lk-fp"><span>Showing now</span><code>{prettyFingerprint(send.newFingerprint)}</code></div>
                        <p>Trust it only if you reset, updated or reinstalled the printer.</p>
                        <div className="lk-row end"><button type="button" className="btn danger" data-testid="send-cert-trust" onClick={() => void trust()}><ShieldWarning size={13} /> Trust the new certificate</button></div>
                      </div>
                    )}
                  </>
                )
                : (
                  <>
                    <div className="sc-bar" role="progressbar" aria-valuenow={pct}><div style={{ width: `${done ? 100 : Math.max(3, pct)}%` }} /></div>
                    <div className="sc-line">{done ? <CheckCircle size={14} weight="fill" className="lk-ok" /> : send.stage === 'cancelled' ? <Warning size={13} weight="fill" /> : <CircleNotch size={13} className="sc-spin" />}<span>{STAGE[send.stage] ?? send.stage}{send.stage === 'uploading' && send.total ? `, ${pct}%` : ''}</span></div>
                  </>
                )}
            </div>
          )}
          {trusted && !send && <div className="lk-note" data-testid="send-trusted"><CheckCircle size={14} weight="fill" className="lk-ok" /><span>Trusted. Send again.</span></div>}
          {err && <div className="lk-err" data-testid="send-error"><Warning size={13} weight="fill" /> {err}</div>}
        </div>
        <footer className="lk-send-f">
          {done
            ? <button type="button" className="btn primary" data-testid="send-view" onClick={() => { setPanel(true); clearSend(); setSendOpen(false) }}>View on printer</button>
            : (
              <>
                <button type="button" className="btn" data-testid="send-cancel" disabled={send?.stage === 'starting'} onClick={() => (sending ? void cancelSend() : close())}>{sending ? 'Cancel send' : 'Cancel'}</button>
                <button type="button" className="btn primary" data-testid="send-go" disabled={sending || conn !== 'ready' || !printer || !status?.online || !!status?.problem} onClick={() => void go()}><PaperPlaneTilt size={14} /> Send</button>
              </>
            )}
        </footer>
      </div>
    </div>,
    document.body,
  )
}
