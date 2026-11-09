/** The Printers panel: CADdy Link status, pairing, one live card per printer (any kind), and adding a printer. */
import { useEffect, useRef, useState } from 'react'
import {
  ArrowSquareOut, CircleNotch, DownloadSimple, Drop, Fan, Lightbulb, MagnifyingGlass, Pause, Play, Plugs, Plus, Printer, ShieldWarning, Stop, Thermometer, Trash, Warning, WifiHigh, X,
} from '@phosphor-icons/react'
import { Segmented } from '@/ui/Segmented'
import { Checkbox } from '@/ui/Toggle'
import { Tip } from '@/ui/Tooltip'
import { addPrinter, control, setAddOpen, discover, pair, removePrinter, retryLink, setLight, setPanel, setSpeed, trustCertificate } from './client'
import { durationText, etaText, HUMIDITY, isActive, plainLinkError, prettyFingerprint, printerModel, STATE_LABEL } from './logic'
import type { AmsUnit, Discovered, PrinterInfo, PrinterKind, PrinterStatus, Temp, Tray } from './protocol'
import { useLink } from './store'
import './link.css'

export const RELEASES = 'https://github.com/WrathPak/caddy-mccadface/releases'

function NotRunning({ blocked, versionError }: { blocked: boolean; versionError: string | null }) {
  return (
    <div className="lk-empty" data-testid={blocked ? 'link-blocked' : 'link-off'}>
      <div className="lk-hero"><Plugs size={30} weight="duotone" /></div>
      {versionError ? (
        <>
          <h3>CADdy Link needs an update</h3>
          <p>{versionError}</p>
        </>
      ) : blocked ? (
        <>
          <h3>The browser blocked CADdy Link</h3>
          <p>Allow this site to connect to devices on your network in the browser's site settings, then try again.</p>
        </>
      ) : (
        <>
          <h3>CADdy Link isn't running</h3>
          <p>A small program on this computer that lets the app talk to your printers (Bambu Lab, Prusa, Klipper, OctoPrint) on your own network. Nothing goes through the internet.</p>
          <ol className="lk-steps">
            <li>Download CADdy Link for your system.</li>
            <li>Run it. It prints a 6 digit pairing code in its window.</li>
            <li>Come back here and enter the code.</li>
          </ol>
        </>
      )}
      <div className="lk-row">
        <a className="btn primary" href={RELEASES} target="_blank" rel="noreferrer" data-testid="link-download"><DownloadSimple size={14} /> Download <ArrowSquareOut size={12} /></a>
        <button type="button" className="btn" data-testid="link-retry" onClick={retryLink}>Try again</button>
      </div>
      {!blocked && !versionError && <div className="lk-wait"><CircleNotch size={12} className="sc-spin" /> Looking for it</div>}
    </div>
  )
}

function Pairing() {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const err = useLink((s) => s.pairError)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  const go = async (c: string) => {
    setBusy(true)
    const ok = await pair(c)
    setBusy(false)
    if (!ok) setCode('')
  }
  return (
    <div className="lk-empty" data-testid="link-pairing">
      <div className="lk-hero"><Plugs size={30} weight="duotone" /></div>
      <h3>Pair with CADdy Link</h3>
      <p>Type the 6 digit code shown in the CADdy Link window. You only do this once for this browser.</p>
      <div className="lk-code" data-busy={busy}>
        {Array.from({ length: 6 }, (_, i) => <span key={i} data-on={i < code.length} data-cur={i === code.length}>{code[i] ?? ''}</span>)}
        <input
          ref={ref} data-testid="pair-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={busy} aria-label="Pairing code"
          onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(v); if (v.length === 6) void go(v) }}
        />
      </div>
      <div className="lk-err" data-testid="pair-error" hidden={!err}>{err}</div>
    </div>
  )
}

/** Progress ring with the percent in the middle. */
function Ring({ pct, state }: { pct: number; state: string }) {
  const r = 27, c = 2 * Math.PI * r
  return (
    <svg className="lk-ring" viewBox="0 0 64 64" data-state={state} aria-hidden>
      <circle cx="32" cy="32" r={r} className="lk-ring-bg" />
      <circle cx="32" cy="32" r={r} className="lk-ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(100, pct)) / 100)} transform="rotate(-90 32 32)" />
      <text x="32" y="36" textAnchor="middle" className="lk-ring-t">{Math.round(pct)}%</text>
    </svg>
  )
}

const deg = (t: Temp | null) => (t ? `${Math.round(t.cur)}${t.target > 0 ? ` / ${Math.round(t.target)}` : ''}°` : '-')

function Chip({ t, active, label }: { t: Tray; active: boolean; label?: string }) {
  return (
    <div className="lk-chip" data-empty={t.empty} data-active={active} data-testid={`ams-slot-${t.id}`} title={t.name || undefined}>
      <span className="sw fil-dot" style={{ background: t.empty ? 'transparent' : t.color ?? 'var(--text-faint)' }} />
      <b>{label ?? (t.empty ? 'Empty' : t.type || '?')}</b>
      <i>{t.empty ? '' : t.remain >= 0 ? `${t.remain}%` : ''}</i>
    </div>
  )
}

function AmsRow({ u, active }: { u: AmsUnit; active: number | null }) {
  const hum = u.humidityPct != null ? `${Math.round(u.humidityPct)}%` : u.humidity ? HUMIDITY[u.humidity] : ''
  return (
    <div className="lk-ams" data-testid={`ams-${u.id}`}>
      <div className="lk-ams-h"><span>AMS {u.id + 1}</span>{hum && <em><Drop size={11} weight="fill" /> {hum}</em>}</div>
      <div className="lk-chips">{u.trays.map((t) => <Chip key={t.id} t={t} active={active === t.id} />)}</div>
    </div>
  )
}

/** The printer shows another security certificate than the one saved. Both fingerprints are shown, and nothing is trusted before the person confirms. */
function CertChanged({ p, s }: { p: PrinterInfo; s: PrinterStatus }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const prob = s.problem!
  const now = prob.newFingerprint
  const trust = async () => {
    if (!now) return
    setBusy(true); setErr('')
    try { await trustCertificate(p.id, now, p.kind === 'bambu' ? 'mqtt' : 'http') } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
  }
  return (
    <div className="lk-cert" data-testid="cert-changed">
      <div className="lk-err"><ShieldWarning size={14} weight="fill" /><span>{prob.message || plainLinkError('cert_changed', '')}</span></div>
      {now && !open && <button type="button" className="btn" data-testid="cert-trust" onClick={() => setOpen(true)}>Trust the new certificate</button>}
      {now && open && (
        <div className="lk-confirm lk-cert-box" data-testid="cert-confirm">
          <div className="lk-fp"><span>Saved when you added it</span><code data-testid="cert-old">{prob.oldFingerprint ? prettyFingerprint(prob.oldFingerprint) : 'not known'}</code></div>
          <div className="lk-fp"><span>Showing now</span><code data-testid="cert-new">{prettyFingerprint(now)}</code></div>
          <p>Trust it only if you reset, updated or reinstalled this printer. If nothing changed, someone on your network may be pretending to be the printer.</p>
          {err && <div className="lk-err"><Warning size={13} weight="fill" /> {err}</div>}
          <div className="lk-row end">
            <button type="button" className="btn" onClick={() => setOpen(false)}>Do not trust</button>
            <button type="button" className="btn danger" data-testid="cert-yes" disabled={busy} onClick={() => void trust()}>{busy && <CircleNotch size={13} className="sc-spin" />} Trust this certificate</button>
          </div>
        </div>
      )}
    </div>
  )
}

const SPEEDS = ['', 'Silent', 'Standard', 'Sport', 'Ludicrous']

function Card({ p }: { p: PrinterInfo }) {
  const s = useLink((x) => x.statuses[p.id]) as PrinterStatus | undefined
  const direct = useLink((x) => !!x.direct[p.id])
  const [askStop, setAskStop] = useState(false)
  const [askRemove, setAskRemove] = useState(false)
  const busy = s ? isActive(s.state) : false
  const tone = !s || !s.online ? 'off' : s.problem ? 'bad' : s.state
  const eta = s && s.remainingMin > 0 && busy ? etaText(s.remainingMin) : ''
  const bambu = p.kind === 'bambu'
  const showJob = busy || s?.state === 'finish' || s?.state === 'stopped' || s?.state === 'failed'
  return (
    <section className="lk-card" data-testid="printer-card" data-printer={p.id} data-kind={p.kind} data-state={s?.state ?? 'unknown'} data-online={s?.online ?? false} data-percent={s?.percent ?? 0} data-layer={s?.layer ?? 0}>
      <header className="lk-card-h">
        <div className="lk-card-t">
          <b data-testid="printer-name">{p.name}</b>
          <span>{printerModel(p)}{bambu ? '' : ` at ${p.ip}`}{p.mock ? ' (simulated)' : ''}{direct && <em className="lk-direct" data-testid="printer-direct" title="This browser talks to Moonraker directly">direct</em>}</span>
        </div>
        <span className="lk-pill" data-tone={tone} data-testid="printer-state">{!s ? 'Connecting' : !s.online ? 'Offline' : s.problem ? 'Problem' : STATE_LABEL[s.state]}</span>
        <Tip label="Remove printer" side="top"><button type="button" className="lk-x" aria-label="Remove printer" data-testid="printer-remove" onClick={() => setAskRemove(true)}><Trash size={13} /></button></Tip>
      </header>
      {askRemove && (
        <div className="lk-confirm" data-testid="remove-confirm">
          <span>Remove {p.name} from CADdy Link?</span>
          <button type="button" className="btn" onClick={() => setAskRemove(false)}>Keep</button>
          <button type="button" className="btn danger" data-testid="remove-yes" onClick={() => void removePrinter(p.id)}>Remove</button>
        </div>
      )}
      {s?.problem?.code === 'cert_changed'
        ? <CertChanged p={p} s={s} />
        : s?.problem && <div className="lk-err" data-testid="printer-problem"><Warning size={13} weight="fill" /> <span>{plainLinkError(s.problem.code, s.problem.message)}</span></div>}
      {s && s.online && !s.problem && (
        <>
          <div className="lk-job">
            <Ring pct={s.percent} state={s.state} />
            <div className="lk-job-t">
              <b className="lk-file" data-testid="printer-file">{showJob ? s.file || 'Print' : 'No print running'}</b>
              <span data-testid="printer-layer">{showJob && (bambu || s.totalLayers > 0) ? `Layer ${s.layer} / ${s.totalLayers}` : !showJob && s.state === 'idle' ? 'Waiting for a job' : ''}</span>
              <span data-testid="printer-eta">{eta ? `${durationText(s.remainingMin)} left, done ${eta}` : ''}</span>
            </div>
          </div>
          <div className="lk-temps">
            <div><Thermometer size={12} /><span>Nozzle</span><b data-testid="temp-nozzle">{deg(s.nozzle)}</b></div>
            <div><Thermometer size={12} /><span>Bed</span><b>{deg(s.bed)}</b></div>
            {s.chamber && <div><Thermometer size={12} /><span>Chamber</span><b>{deg(s.chamber)}</b></div>}
          </div>
          <div className="lk-fans" data-testid="printer-extras">
            {s.fans && <span><Fan size={12} /> Part <b>{s.fans.part}%</b></span>}
            {s.fans && bambu && <span>Aux <b>{s.fans.aux}%</b></span>}
            {s.fans && bambu && <span>Chamber <b>{s.fans.chamber}%</b></span>}
            {bambu && <span>Speed <b>{SPEEDS[s.speedLevel] || '-'}</b></span>}
            {!bambu && s.speedPct != null && <span>Speed <b>{s.speedPct}%</b></span>}
            {s.readouts.map((r) => <span key={r.label}>{r.label} <b>{r.value}</b></span>)}
            {s.wifi != null && <span className="lk-wifi" title="Wi-Fi signal"><WifiHigh size={12} /> {s.wifi} dBm</span>}
          </div>
          {(s.ams.units.length > 0 || s.ams.external) && (
            <div className="lk-amsbox">
              {s.ams.units.map((u) => <AmsRow key={u.id} u={u} active={s.ams.active} />)}
              {s.ams.external && (
                <div className="lk-ams lk-ext" data-testid="ams-external">
                  <div className="lk-ams-h"><span>External spool</span></div>
                  <div className="lk-chips"><Chip t={s.ams.external} active={s.ams.active === 254} label={s.ams.external.empty ? 'Empty' : s.ams.external.type || 'Spool'} /></div>
                </div>
              )}
            </div>
          )}
          {s.hms.length > 0 && (
            <div className="lk-hms" data-testid="printer-hms">
              {s.hms.map((h) => (
                <div key={h.code} data-sev={h.severity} data-known={h.known}>
                  <Warning size={13} weight="fill" />
                  <span>{h.text}<span className="lk-code-line"><code>HMS {h.code}</code>{h.url && <a href={h.url} target="_blank" rel="noreferrer" data-testid="hms-link">What does this mean? <ArrowSquareOut size={10} /></a>}</span></span>
                </div>
              ))}
            </div>
          )}
          {s.printErrorText && (
            <div className="lk-hms" data-testid="printer-error">
              <div data-sev="error">
                <Warning size={13} weight="fill" />
                <span>{s.printErrorText}{s.printError && <span className="lk-code-line"><code>{s.printError}</code>{s.printErrorUrl && <a href={s.printErrorUrl} target="_blank" rel="noreferrer">What does this mean? <ArrowSquareOut size={10} /></a>}</span>}</span>
              </div>
            </div>
          )}
          {busy && bambu && (
            <div className="lk-speed" data-testid="printer-speed">
              <Segmented value={String(s.speedLevel)} onChange={(v) => void setSpeed(p.id, +v as 1 | 2 | 3 | 4)} options={[{ value: '1', label: 'Silent' }, { value: '2', label: 'Standard' }, { value: '3', label: 'Sport' }, { value: '4', label: 'Ludicrous' }]} />
            </div>
          )}
          {askStop ? (
            <div className="lk-confirm" data-testid="stop-confirm">
              <span>Stop this print? It cannot be resumed.</span>
              <button type="button" className="btn" onClick={() => setAskStop(false)}>Keep printing</button>
              <button type="button" className="btn danger" data-testid="stop-yes" onClick={() => { setAskStop(false); void control('printer.stop', p.id) }}>Stop print</button>
            </div>
          ) : (
            <div className="lk-ctl">
              {busy && (s.state === 'pause'
                ? <button type="button" className="btn" data-testid="printer-resume" onClick={() => void control('printer.resume', p.id)}><Play size={13} weight="fill" /> Resume</button>
                : <button type="button" className="btn" data-testid="printer-pause" onClick={() => void control('printer.pause', p.id)}><Pause size={13} weight="fill" /> Pause</button>)}
              {busy && <button type="button" className="btn" data-testid="printer-stop" onClick={() => setAskStop(true)}><Stop size={13} weight="fill" /> Stop</button>}
              <span className="lk-grow" />
              {s.light !== null && (
                <Tip label={s.light ? 'Turn the light off' : 'Turn the light on'} side="top">
                  <button type="button" className="btn lk-light" aria-pressed={s.light} data-on={s.light} data-testid="printer-light" onClick={() => void setLight(p.id, !s.light)}><Lightbulb size={14} weight={s.light ? 'fill' : 'regular'} /></button>
                </Tip>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

const KINDS: { value: PrinterKind; label: string }[] = [{ value: 'bambu', label: 'Bambu Lab' }, { value: 'prusa', label: 'Prusa' }, { value: 'klipper', label: 'Klipper' }, { value: 'octoprint', label: 'OctoPrint' }]

const HINTS: Record<PrinterKind, string> = {
  bambu: 'On the printer, turn on LAN Only mode and Developer Mode. The IP address and the access code are on its screen under Settings, WLAN (or Network). The serial number is on the label and in the printer\'s About page. The access code is kept by CADdy Link on this computer and never comes back to the browser.',
  prusa: 'PrusaLink: the password is on the printer\'s screen under Settings, Network, PrusaLink (the user is maker), and in PrusaLink\'s own Settings page, where you can also make an API key. The login is kept by CADdy Link on this computer and never comes back to the browser.',
  klipper: 'Moonraker listens on port 7125. If this computer is a trusted client in moonraker.conf you need no key; otherwise enter an API key. To let this page talk to the printer directly, add its address to cors_domains in moonraker.conf (optional: without it CADdy Link carries everything).',
  octoprint: 'Make an API key in OctoPrint under Settings, Application Keys, and paste it here. OctoPrint listens on port 5000, or on 80 when it runs on OctoPi. The key is kept by CADdy Link on this computer and never comes back to the browser.',
}

const PORT_HINT: Record<PrinterKind, string> = { bambu: '', prusa: '80', klipper: '7125', octoprint: '5000' }

function AddPrinterForm({ onDone }: { onDone: () => void }) {
  const found = useLink((s) => s.discovered)
  const searching = useLink((s) => s.discovering)
  const known = useLink((s) => s.printers)
  const [kind, setKind] = useState<PrinterKind>('bambu')
  const [auth, setAuth] = useState<'password' | 'key'>('password')
  const [tls, setTls] = useState(false)
  const [f, setF] = useState({ name: '', ip: '', port: '', serial: '', accessCode: '', username: '', password: '', apiKey: '', mqttPort: undefined as number | undefined, ftpPort: undefined as number | undefined, model: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const find = async () => { setErr(''); try { await discover() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } }
  useEffect(() => { void find() }, [])
  const use = (d: Discovered) => {
    const k = d.kind ?? 'bambu'
    setKind(k)
    setF({
      ...f, name: d.name, ip: d.ip, serial: d.serial ?? '', port: d.port ? String(d.port) : '', mqttPort: d.mqttPort, ftpPort: d.ftpPort, model: d.model ?? '',
      accessCode: k === 'bambu' ? d.accessCode ?? f.accessCode : f.accessCode,
      password: k === 'prusa' ? d.accessCode ?? '' : '', apiKey: k === 'octoprint' ? d.accessCode ?? '' : '',
    })
    if (k === 'prusa') setAuth('password')
  }
  const ok = !!f.ip.trim() && (kind === 'bambu' ? !!f.serial.trim() && !!f.accessCode.trim() : kind === 'prusa' ? (auth === 'password' ? !!f.password.trim() : !!f.apiKey.trim()) : kind === 'octoprint' ? !!f.apiKey.trim() : true)
  const submit = async () => {
    setBusy(true); setErr('')
    try {
      const port = f.port.trim() ? Number(f.port) : undefined
      if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('That port number is not valid.')
      await addPrinter(kind === 'bambu'
        ? { kind, name: f.name.trim() || undefined, ip: f.ip.trim(), serial: f.serial.trim(), accessCode: f.accessCode.trim(), mqttPort: f.mqttPort, ftpPort: f.ftpPort, model: f.model || undefined }
        : { kind, name: f.name.trim() || undefined, ip: f.ip.trim(), port, tls, ...(kind === 'prusa' && auth === 'password' ? { username: f.username.trim() || undefined, password: f.password.trim() } : { apiKey: f.apiKey.trim() || undefined }) })
      onDone()
    } catch (e) {
      const code = (e as { code?: string }).code ?? ''
      setErr(plainLinkError(code, e instanceof Error ? e.message : String(e)))
    }
    setBusy(false)
  }
  const list = (found ?? []).filter((d) => !known.some((k) => (d.kind ?? 'bambu') === k.kind && (k.kind === 'bambu' ? k.serial === d.serial : k.ip === d.ip && k.port === d.port)))
  return (
    <div className="lk-add" data-testid="add-form" data-kind={kind}>
      <div className="lk-add-h">
        <b>Add a printer</b>
        <button type="button" className="btn" data-testid="discover-go" disabled={searching} onClick={() => void find()}>
          {searching ? <CircleNotch size={13} className="sc-spin" /> : <MagnifyingGlass size={13} />} Find printers
        </button>
      </div>
      {list.length > 0 && (
        <div className="lk-found" data-testid="found-list">
          {list.map((d) => (
            <button type="button" key={`${d.kind}${d.serial}${d.ip}${d.port ?? ''}`} className="lk-found-i" data-testid="found-printer" data-kind={d.kind} data-serial={d.serial} data-name={d.name} data-on={f.ip === d.ip && f.port === (d.port ? String(d.port) : '') && f.serial === (d.serial ?? '')} onClick={() => use(d)}>
              <Printer size={16} weight="duotone" /><span><b>{d.name || d.serial}</b><i>{d.kind === 'bambu' || !d.kind ? d.modelLabel.replace('Bambu Lab ', '') : d.modelName} at {d.ip}{d.port && d.kind !== 'bambu' ? `:${d.port}` : ''}</i></span>
            </button>
          ))}
        </div>
      )}
      {!searching && found && list.length === 0 && <p className="lk-hint">No new printers found on your network. Enter one by hand below.</p>}
      <div className="lk-kind" data-testid="add-kind">
        <Segmented value={kind} onChange={(v) => { setKind(v as PrinterKind); setErr('') }} options={KINDS} />
      </div>
      <div className="lk-fields">
        <label><span>Name</span><input className="sl-input" data-testid="add-name" placeholder="Optional" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label><span>IP address</span><input className="sl-input" data-testid="add-ip" placeholder="192.168.1.50" inputMode="decimal" value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} /></label>
        {kind === 'bambu' && (
          <>
            <label><span>Serial number</span><input className="sl-input" data-testid="add-serial" value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} /></label>
            <label><span>Access code</span><input className="sl-input" data-testid="add-code" autoComplete="off" value={f.accessCode} onChange={(e) => setF({ ...f, accessCode: e.target.value })} /></label>
          </>
        )}
        {kind !== 'bambu' && (
          <>
            <label><span>Port</span><input className="sl-input" data-testid="add-port" placeholder={PORT_HINT[kind]} inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, '') })} /></label>
            <div className="lk-fld lk-wide" data-testid="add-tls"><Checkbox checked={tls} onChange={setTls} label="Use HTTPS" help="Turn on when the printer's web page opens with https://. CADdy Link accepts its own certificate the first time and warns if it changes." /></div>
          </>
        )}
        {kind === 'prusa' && (
          <>
            <div className="lk-fld lk-wide"><span>Sign in with</span><Segmented value={auth} onChange={(v) => setAuth(v as 'password' | 'key')} options={[{ value: 'password', label: 'Password' }, { value: 'key', label: 'API key' }]} /></div>
            {auth === 'password'
              ? (
                <>
                  <label><span>User</span><input className="sl-input" data-testid="add-user" placeholder="maker" autoComplete="off" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></label>
                  <label><span>Password</span><input className="sl-input" type="password" data-testid="add-password" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
                </>
              )
              : <label className="lk-wide"><span>API key</span><input className="sl-input" type="password" data-testid="add-key" autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>}
          </>
        )}
        {(kind === 'klipper' || kind === 'octoprint') && (
          <label className="lk-wide"><span>API key{kind === 'klipper' ? ' (only if Moonraker asks for one)' : ''}</span><input className="sl-input" type="password" data-testid="add-key" autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} /></label>
        )}
      </div>
      <p className="lk-hint">{HINTS[kind]}</p>
      <div className="lk-err" data-testid="add-error" hidden={!err}><Warning size={13} weight="fill" /> {err}</div>
      <div className="lk-row end">
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button type="button" className="btn primary" data-testid="add-go" disabled={!ok || busy} onClick={() => void submit()}>{busy ? <CircleNotch size={13} className="sc-spin" /> : <Plus size={13} />} Add printer</button>
      </div>
    </div>
  )
}

export function PrintersPanel() {
  const { panelOpen, conn, printers, mock, versionError, addOpen: adding } = useLink()
  const setAdding = setAddOpen
  useEffect(() => {
    if (!panelOpen) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) setPanel(false) }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [panelOpen])
  if (!panelOpen) return null
  return (
    <aside className="lk-panel" role="dialog" aria-label="Printers" data-testid="printers-panel" data-conn={conn}>
      <header className="lk-head">
        <div className="lk-title"><Printer size={18} weight="duotone" /><h2>Printers</h2>{mock && <em data-testid="link-mock">simulated</em>}</div>
        <span className="lk-conn" data-conn={conn} data-testid="link-conn">{conn === 'ready' ? 'Connected' : conn === 'connecting' ? 'Connecting' : conn === 'pairing' ? 'Pairing' : conn === 'blocked' ? 'Blocked' : 'Not running'}</span>
        {conn === 'ready' && !adding && <Tip label="Add a printer" side="bottom"><button type="button" className="lk-x" aria-label="Add a printer" data-testid="printers-add" onClick={() => setAdding(true)}><Plus size={16} /></button></Tip>}
        <button type="button" className="lk-x" aria-label="Close" data-testid="printers-close" onClick={() => setPanel(false)}><X size={16} /></button>
      </header>
      <div className="lk-body">
        {conn === 'connecting' && !versionError && <div className="lk-empty"><CircleNotch size={20} className="sc-spin" /></div>}
        {(conn === 'off' || conn === 'blocked') && <NotRunning blocked={conn === 'blocked'} versionError={versionError} />}
        {conn === 'pairing' && <Pairing />}
        {conn === 'ready' && adding && <AddPrinterForm onDone={() => setAdding(false)} />}
        {conn === 'ready' && !adding && (
          printers.length === 0
            ? (
              <div className="lk-empty" data-testid="printers-empty">
                <div className="lk-hero"><Printer size={30} weight="duotone" /></div>
                <h3>No printers yet</h3>
                <p>Add a printer on your network (Bambu Lab, Prusa, Klipper or OctoPrint) to see it live and send prints to it.</p>
                <button type="button" className="btn primary" data-testid="printers-add-first" onClick={() => setAdding(true)}><Plus size={14} /> Add a printer</button>
              </div>
            )
            : <div className="lk-list">{printers.map((p) => <Card key={p.id} p={p} />)}</div>
        )}
      </div>
    </aside>
  )
}
