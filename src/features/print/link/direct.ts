/**
 * Klipper (Moonraker) straight from the browser. Moonraker answers a page only when its origin is in `cors_domains`, and a printer
 * with no API key (a trusted client) needs no secret, so this path never carries one. It is tried for such printers and drops back
 * to the helper whenever the browser cannot reach it: the status then comes from the helper again, and so does the upload.
 *
 * Status is a WebSocket speaking JSON-RPC (server.info, printer.objects.subscribe, notify_status_update). The job commands and the
 * upload (POST /server/files/upload, with print=true) are plain HTTP.
 */
import { useLink } from './store'
import type { PrinterInfo, PrinterStatus, PrintState } from './protocol'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

const STATE: Record<string, PrintState> = { standby: 'idle', printing: 'running', paused: 'pause', complete: 'finish', cancelled: 'stopped', error: 'failed' }
const OBJECTS = { print_stats: null, display_status: null, virtual_sdcard: null, extruder: null, heater_bed: null, fan: null, toolhead: null }

/** Merge a notify_status_update into the picture, object by object (the same deep merge the helper does). */
export function mergeStatus(dst: Obj, src: Obj): Obj {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) mergeStatus(dst[k] as Obj, v as Obj)
    else dst[k] = v
  }
  return dst
}

/** What Moonraker's objects say, as the status the printer card shows. The same mapping as helper/internal/lan/klipper.go. */
export function klipperStatus(printerId: string, raw: Obj, klippy = 'ready'): PrinterStatus {
  const ps = obj(raw.print_stats), ds = obj(raw.display_status), vs = obj(raw.virtual_sdcard)
  const ex = obj(raw.extruder), bed = obj(raw.heater_bed), fan = obj(raw.fan), th = obj(raw.toolhead)
  const gcodeState = str(ps.state)
  const state: PrintState = STATE[gcodeState] ?? 'unknown'
  let progress = num(ds.progress)
  if (progress <= 0) progress = num(vs.progress)
  const dur = num(ps.print_duration)
  const info = obj(ps.info)
  const pos = Array.isArray(th.position) ? (th.position as unknown[]) : []
  const readouts = typeof pos[2] === 'number' ? [{ label: 'Height', value: `${(pos[2] as number).toFixed(2)} mm` }] : []
  return {
    printerId, kind: 'klipper', online: true,
    problem: klippy === 'ready' || klippy === '' ? null : { code: 'not_ready', message: `Klipper is ${klippy}. Check the Klipper log, then restart the firmware from your web interface.` },
    state, gcodeState,
    percent: state === 'finish' ? 100 : Math.max(0, Math.min(100, Math.round(progress * 100))),
    remainingMin: state === 'running' && progress > 0.01 ? Math.ceil(Math.max(0, dur / progress - dur) / 60) : 0,
    layer: num(info.current_layer), totalLayers: num(info.total_layer),
    file: str(ps.filename),
    nozzle: { cur: num(ex.temperature), target: num(ex.target) },
    bed: { cur: num(bed.temperature), target: num(bed.target) },
    chamber: null,
    fans: typeof fan.speed === 'number' ? { part: Math.round(fan.speed * 100), aux: 0, chamber: 0 } : null,
    speedLevel: 2, speedPct: null, readouts, light: null,
    ams: { units: [], external: null, active: null },
    hms: [], printError: '', printErrorText: str(ps.message).trim(), printErrorUrl: '', wifi: null, sdcard: null, updatedAt: Date.now(),
  }
}

const isLoopback = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '::1'

/** The browser may try this printer directly: no secret held for it, and a page on https may only reach plain http on this computer. */
export function canDirect(p: PrinterInfo): boolean {
  if (p.kind !== 'klipper' || p.secret || p.tls || !p.ip) return false
  return typeof location !== 'undefined' && (location.protocol === 'http:' || isLoopback(p.ip))
}

const base = (p: PrinterInfo) => `http://${p.ip.includes(':') ? `[${p.ip}]` : p.ip}:${p.port}`

interface Conn { ws: WebSocket | null; raw: Obj; klippy: string; subscribed: boolean; opened: boolean; retryAt: number; id: number }
const conns = new Map<string, Conn>()
let timer: ReturnType<typeof setInterval> | null = null

function setDirect(id: string, on: boolean) {
  const s = useLink.getState()
  if (!!s.direct[id] !== on) useLink.setState({ direct: { ...s.direct, [id]: on } })
}

function publish(id: string, c: Conn) {
  setDirect(id, true)
  useLink.setState({ statuses: { ...useLink.getState().statuses, [id]: klipperStatus(id, c.raw, c.klippy) } })
}

function rpc(c: Conn, method: string, params?: Obj) {
  if (c.ws?.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ jsonrpc: '2.0', method, id: ++c.id, ...(params ? { params } : {}) }))
}

function connect(p: PrinterInfo, c: Conn) {
  let ws: WebSocket
  try { ws = new WebSocket(`ws://${p.ip.includes(':') ? `[${p.ip}]` : p.ip}:${p.port}/websocket`) } catch { c.retryAt = Date.now() + 60000; return }
  c.ws = ws
  c.opened = false
  c.subscribed = false
  c.raw = {}
  const giveUp = setTimeout(() => { if (!c.opened) ws.close() }, 4000)
  ws.onopen = () => { c.opened = true; clearTimeout(giveUp); rpc(c, 'server.info') }
  ws.onmessage = (e) => {
    let m: Obj
    try { m = JSON.parse(String(e.data)) as Obj } catch { return }
    const method = str(m.method)
    if (method === 'notify_status_update') {
      const params = Array.isArray(m.params) ? m.params : []
      mergeStatus(c.raw, obj(params[0]))
      return publish(p.id, c)
    }
    if (method === 'notify_klippy_ready' || method === 'notify_klippy_shutdown' || method === 'notify_klippy_disconnected') { c.subscribed = false; return rpc(c, 'server.info') }
    const res = obj(m.result)
    if (typeof res.klippy_state === 'string') {
      c.klippy = res.klippy_state
      if (c.klippy === 'ready' && !c.subscribed) { c.subscribed = true; rpc(c, 'printer.objects.subscribe', { objects: OBJECTS }) }
      return publish(p.id, c)
    }
    if (res.status) { mergeStatus(c.raw, obj(res.status)); publish(p.id, c) }
  }
  ws.onclose = () => {
    clearTimeout(giveUp)
    if (c.ws !== ws) return
    c.ws = null
    // never opened: Moonraker does not allow this page (or is not reachable), so the helper carries it; a break later is retried soon
    c.retryAt = Date.now() + (c.opened ? 3000 : 60000)
    setDirect(p.id, false)
  }
  ws.onerror = () => { /* onclose follows */ }
}

/** Open or drop direct connections to match the printers the helper reports. Safe to call often. */
export function syncDirect(printers: PrinterInfo[]) {
  const want = new Set(printers.filter(canDirect).map((p) => p.id))
  for (const [id, c] of conns) {
    if (!want.has(id)) { c.ws?.close(); conns.delete(id); setDirect(id, false) }
  }
  for (const p of printers) {
    if (!want.has(p.id)) continue
    let c = conns.get(p.id)
    if (!c) { c = { ws: null, raw: {}, klippy: '', subscribed: false, opened: false, retryAt: 0, id: 0 }; conns.set(p.id, c) }
    if (!c.ws && Date.now() >= c.retryAt) connect(p, c)
  }
  if (want.size && !timer) timer = setInterval(() => syncDirect(useLink.getState().printers), 5000)
  if (!want.size && timer) { clearInterval(timer); timer = null }
}

/** Close every direct connection (the helper connection ended). */
export function stopDirect() {
  for (const [, c] of conns) c.ws?.close()
  conns.clear()
  if (timer) { clearInterval(timer); timer = null }
  useLink.setState({ direct: {} })
}

/** Pause, resume or cancel straight to Moonraker. false means "not direct, or the browser could not reach it": use the helper. */
export async function directControl(p: PrinterInfo, action: 'pause' | 'resume' | 'cancel'): Promise<boolean> {
  if (!useLink.getState().direct[p.id]) return false
  try {
    const r = await fetch(`${base(p)}/printer/print/${action}`, { method: 'POST' })
    if (r.ok) return true
    throw new Error((await r.text().catch(() => '')) || `Klipper answered ${r.status}`)
  } catch (e) {
    if (e instanceof TypeError) return false // blocked or unreachable from the browser
    throw e
  }
}

let abortUpload: (() => void) | null = null

/** Cancel an upload that is going straight to Moonraker. */
export function cancelDirectUpload(): boolean {
  if (!abortUpload) return false
  abortUpload()
  return true
}

export type DirectResult = 'done' | 'cancelled' | 'unreachable' | { error: string }

/** Upload straight to Moonraker (POST /server/files/upload, root gcodes, print true). 'unreachable' means the helper should send it instead. */
export function directUpload(p: PrinterInfo, name: string, bytes: Uint8Array, progress: (sent: number) => void): Promise<DirectResult> {
  return new Promise((resolve) => {
    const form = new FormData()
    form.append('root', 'gcodes')
    form.append('print', 'true')
    form.append('file', new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' }), name)
    const x = new XMLHttpRequest()
    x.open('POST', `${base(p)}/server/files/upload`)
    x.upload.onprogress = (e) => { if (e.lengthComputable) progress(Math.min(bytes.length, Math.round((e.loaded / e.total) * bytes.length))) }
    x.onload = () => {
      abortUpload = null
      if (x.status === 201 || x.status === 200) {
        let res: Obj = {}
        try { res = JSON.parse(x.responseText) as Obj } catch { /* not json */ }
        return resolve(res.print_started === false && res.print_queued !== true ? { error: 'The file is on the printer, but Klipper did not start it. It may not be ready, or it may be busy.' } : 'done')
      }
      resolve({ error: x.status === 400 || x.status === 409 ? `Klipper refused the file. ${x.responseText.slice(0, 160)}` : `Klipper answered ${x.status}.` })
    }
    x.onerror = () => { abortUpload = null; resolve('unreachable') }
    x.onabort = () => { abortUpload = null; resolve('cancelled') }
    abortUpload = () => x.abort()
    x.send(form)
  })
}
