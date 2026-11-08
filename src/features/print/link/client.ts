/**
 * The CADdy Link client: one WebSocket to the helper on 127.0.0.1, opened only while the Printers panel or the send dialog is open
 * (so the browser's local network prompt never shows up for someone who does not use printers). Reconnects with a backoff while wanted.
 */
import { toast } from '@/ui/Modal'
import { LINK_PORT, LINK_VERSION, type AddPrinter, type Discovered, type ErrorMsg, type FromHelper, type PrinterInfo, type RequestMap, type RequestType, type SendBegin } from './protocol'
import { useLink, type LinkConn } from './store'

const TOKEN_KEY = 'caddy.link.token'
const PORT_KEY = 'caddy.link.port'

const read = (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private mode */ } }

const portNow = () => { const n = Number(read(PORT_KEY)); return Number.isInteger(n) && n > 0 && n < 65536 ? n : LINK_PORT }

export class LinkError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

interface Pending { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

let ws: WebSocket | null = null
let wanted = false
let opened = false
let retry: ReturnType<typeof setTimeout> | null = null
let delay = 1000
let nextId = 1
const pending = new Map<string, Pending>()
const CHUNK = 256 * 1024

const setConn = (conn: LinkConn) => useLink.setState({ conn })

function failAll(why: string) {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new LinkError('closed', why)) }
  pending.clear()
}

/** Ask the helper something and wait for its reply. */
export function request<T extends RequestType>(type: T, body: RequestMap[T]['req'], timeoutMs = 30000): Promise<RequestMap[T]['res']> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new LinkError('closed', 'CADdy Link is not connected'))
    const id = String(nextId++)
    const timer = setTimeout(() => { pending.delete(id); reject(new LinkError('timeout', 'CADdy Link did not answer')) }, timeoutMs)
    pending.set(id, { resolve: resolve as Pending['resolve'], reject, timer })
    ws.send(JSON.stringify({ id, type, ...body }))
  })
}

async function afterAuth() {
  setConn('ready')
  delay = 1000
}

async function authenticate() {
  const token = read(TOKEN_KEY)
  if (!token) return setConn('pairing')
  try {
    await request('auth', { token })
    await afterAuth()
  } catch (e) {
    if (e instanceof LinkError && e.code === 'closed') return
    // the helper forgot this browser: pair again
    write(TOKEN_KEY, null)
    setConn('pairing')
  }
}

function onMessage(raw: string) {
  let m: FromHelper
  try { m = JSON.parse(raw) as FromHelper } catch { return }
  const s = useLink.getState()
  switch (m.type) {
    case 'hello': {
      if (m.version !== LINK_VERSION) {
        useLink.setState({ versionError: `CADdy Link speaks protocol ${m.version}, this app needs ${LINK_VERSION}. Update whichever is older.`, conn: 'off' })
        wanted = false
        ws?.close()
        return
      }
      useLink.setState({ versionError: null, mock: m.mock, helper: m.helper })
      void authenticate()
      return
    }
    case 'reply': case 'error': {
      const id = (m as { id?: string }).id
      const p = id ? pending.get(id) : undefined
      if (!p || !id) {
        if (m.type === 'error') toast((m as ErrorMsg).message, 'error')
        return
      }
      pending.delete(id)
      clearTimeout(p.timer)
      if (m.type === 'error') p.reject(new LinkError(m.code, m.message))
      else p.resolve(m as unknown as Record<string, unknown>)
      return
    }
    case 'printers': {
      const ids = new Set(m.printers.map((p) => p.id))
      useLink.setState({ printers: m.printers, statuses: Object.fromEntries(Object.entries(s.statuses).filter(([k]) => ids.has(k))) })
      return
    }
    case 'status': useLink.setState({ statuses: { ...s.statuses, [m.status.printerId]: m.status } }); return
    case 'send': {
      const cur = s.send
      if (cur && cur.jobId !== m.jobId && cur.jobId !== '') return
      useLink.setState({ send: { jobId: m.jobId, printerId: m.printerId, fileName: cur?.fileName ?? '', stage: m.stage, sent: m.sent, total: m.total, code: m.code, message: m.message } })
      return
    }
  }
}

/** Is the browser's own permission for local network access refused? Only Chrome has this; anything else reads as "not running". */
async function loopbackDenied(): Promise<boolean> {
  try {
    const r = await navigator.permissions.query({ name: 'loopback-network' as PermissionName })
    return r.state === 'denied'
  } catch { return false }
}

function scheduleRetry() {
  if (retry || !wanted) return
  retry = setTimeout(() => { retry = null; open() }, delay)
  delay = Math.min(15000, Math.round(delay * 1.7))
}

function open() {
  if (!wanted || ws) return
  opened = false
  setConn('connecting')
  let sock: WebSocket
  try { sock = new WebSocket(`ws://127.0.0.1:${portNow()}`) } catch { setConn('off'); scheduleRetry(); return }
  ws = sock
  sock.onopen = () => { opened = true }
  sock.onmessage = (e) => { if (typeof e.data === 'string') onMessage(e.data) }
  sock.onclose = () => {
    if (ws !== sock) return
    ws = null
    failAll('The connection to CADdy Link closed')
    const was = opened
    void (async () => {
      if (useLink.getState().versionError) return
      if (!was && (await loopbackDenied())) setConn('blocked')
      else if (!was) setConn('off')
      else setConn('connecting')
      scheduleRetry()
    })()
  }
}

/** Start connecting and keep trying while something needs the helper. */
export function wantLink() {
  wanted = true
  if (!ws) { delay = 1000; open() }
}

/** Nothing needs the helper now: close the connection unless a file is on its way. */
export function releaseLink() {
  const s = useLink.getState()
  if (s.panelOpen || s.sendOpen) return
  const st = s.send?.stage
  if (st === 'receiving' || st === 'uploading' || st === 'starting') return
  wanted = false
  if (retry) { clearTimeout(retry); retry = null }
  ws?.close()
  ws = null
  failAll('closed')
  setConn('off')
}

/** Try again now (the Try again button). */
export function retryLink() {
  if (retry) { clearTimeout(retry); retry = null }
  delay = 1000
  useLink.setState({ versionError: null })
  wantLink()
  if (!ws) open()
}

export function setPanel(open: boolean) {
  useLink.setState({ panelOpen: open })
  if (open) wantLink(); else releaseLink()
}
export const togglePrinters = () => setPanel(!useLink.getState().panelOpen)

export function setSendOpen(open: boolean) {
  useLink.setState({ sendOpen: open })
  if (open) wantLink(); else releaseLink()
}

/** Pair with the code the helper prints; keeps the token it returns. */
export async function pair(code: string): Promise<boolean> {
  useLink.setState({ pairError: null })
  try {
    const r = await request('pair', { code })
    write(TOKEN_KEY, r.token)
    await request('auth', { token: r.token })
    await afterAuth()
    return true
  } catch (e) {
    useLink.setState({ pairError: e instanceof LinkError && e.code === 'bad_code' ? 'That code is not right. Look at the CADdy Link window for the current one.' : e instanceof Error ? e.message : String(e) })
    return false
  }
}

export async function discover(): Promise<Discovered[]> {
  useLink.setState({ discovering: true })
  try {
    const r = await request('printers.discover', {}, 20000)
    useLink.setState({ discovered: r.found })
    return r.found
  } finally {
    useLink.setState({ discovering: false })
  }
}

export async function addPrinter(p: AddPrinter): Promise<PrinterInfo> {
  const r = await request('printers.add', p, 45000)
  return r.printer
}

export const removePrinter = (printerId: string) => request('printers.remove', { printerId })

/** Run a control command and say so plainly when the printer refuses it. */
export async function control(type: 'printer.pause' | 'printer.resume' | 'printer.stop', printerId: string) {
  try { await request(type, { printerId }) } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error') }
}
export async function setLight(printerId: string, on: boolean) {
  try { await request('printer.light', { printerId, on }) } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error') }
}

export async function setSpeed(printerId: string, level: 1 | 2 | 3 | 4) {
  try { await request('printer.speed', { printerId, level }) } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error') }
}

/** Send a file to a printer: tell the helper, then stream the bytes in frames. Progress arrives as `send` events into the store. */
export async function sendFile(begin: Omit<SendBegin, 'size'>, bytes: Uint8Array): Promise<void> {
  useLink.setState({ send: { jobId: '', printerId: begin.printerId, fileName: begin.fileName, stage: 'receiving', sent: 0, total: bytes.length } })
  try {
    const { jobId } = await request('send.begin', { ...begin, size: bytes.length })
    useLink.setState({ send: { ...useLink.getState().send!, jobId } })
    for (let at = 0; at < bytes.length; at += CHUNK) {
      const sock = ws
      if (!sock || sock.readyState !== WebSocket.OPEN) throw new LinkError('closed', 'The connection to CADdy Link closed while sending')
      while (sock.bufferedAmount > 4 * CHUNK) await new Promise((r) => setTimeout(r, 15))
      sock.send(bytes.subarray(at, Math.min(bytes.length, at + CHUNK)) as unknown as BufferSource)
    }
  } catch (e) {
    const code = e instanceof LinkError ? e.code : 'internal'
    useLink.setState({ send: { ...useLink.getState().send!, stage: 'error', code: code as never, message: e instanceof Error ? e.message : String(e) } })
  }
}

export async function cancelSend() {
  const j = useLink.getState().send
  if (j?.jobId) try { await request('send.cancel', { jobId: j.jobId }) } catch { /* already over */ }
}

export const clearSend = () => { useLink.setState({ send: null }); releaseLink() }
