/**
 * The CADdy Link wire protocol, version 1: JSON text frames over a WebSocket to ws://127.0.0.1:47821, plus binary frames for a file upload.
 * The Go side is helper/internal/server/proto.go and must stay in step with this file.
 *
 * Flow: the helper sends `hello` first. The app answers `auth` with its stored token, or `pair` with the code the helper printed.
 * Every other request needs an authed connection. Requests carry an `id`; the answer is a `reply` or an `error` with the same id.
 * The helper also pushes events (`printers`, `status`, `send`) to an authed connection, and sends the first ones right after auth.
 */

export const LINK_VERSION = 1
export const LINK_PORT = 47821
export const LINK_URL = `ws://127.0.0.1:${LINK_PORT}`

export type ErrorCode =
  | 'unauthorized' | 'pairing_required' | 'bad_code' | 'bad_request' | 'not_found' | 'unreachable' | 'bad_access_code'
  | 'cert_changed' | 'offline' | 'busy' | 'dev_mode' | 'sd_missing' | 'upload_failed' | 'print_rejected' | 'internal'
  | 'bad_login' | 'not_ready' | 'not_connected' | 'cancelled' | 'closed' | 'timeout'

export interface HelloMsg { type: 'hello'; version: number; helper: string; capabilities: string[]; mock: boolean }

/** The kinds of printer. Bambu uses MQTT and FTPS; the others are web APIs on the LAN that the helper talks to (Moonraker also directly from the browser when it allows this page). */
export type PrinterKind = 'bambu' | 'prusa' | 'klipper' | 'octoprint'

/** A printer the helper keeps. The access code, password and API key are never in here. */
export interface PrinterInfo {
  id: string
  name: string
  kind: PrinterKind
  /** Bambu model code as the printer announces it ("C12", "N2S", "BL-P001"); empty for the other kinds */
  model: string
  /** the short name ("P1S", "A1 mini", "X1C"), or the kind's name ("PrusaLink", "Klipper", "OctoPrint") */
  modelName: string
  /** the machine preset name prefix in Orca's profiles ("Bambu Lab P1S", "Bambu Lab A1 mini", "Bambu Lab X1 Carbon"); empty for the other kinds */
  modelLabel: string
  serial: string
  ip: string
  /** where the web API listens (the other kinds) */
  port: number
  tls: boolean
  /** the helper holds a password or API key for this printer. A Klipper printer without one may be reachable straight from the browser. */
  secret: boolean
  /** the helper is pinned to this printer's certificate */
  pinned: boolean
  /** the printer starts jobs from storage it reports (H2D, H2S, P2S): the app can mention the SD card or the storage */
  storage: boolean
  mock: boolean
}

export interface Discovered { kind: PrinterKind; serial: string; name: string; model: string; modelName: string; modelLabel: string; ip: string; port?: number; mqttPort?: number; ftpPort?: number; mock?: boolean; accessCode?: string }

/** Adding a printer: Bambu needs serial and access code; the others need an address, and a password (PrusaLink) or an API key (OctoPrint; optional for Klipper). */
export interface AddPrinter {
  kind?: PrinterKind
  name?: string
  ip: string
  serial?: string
  accessCode?: string
  model?: string
  mqttPort?: number
  ftpPort?: number
  port?: number
  tls?: boolean
  /** PrusaLink's digest user, "maker" when empty */
  username?: string
  password?: string
  apiKey?: string
}

export type SendOptions = {
  /** printers with an AMS: use it with `amsMapping` */
  useAms: boolean
  /** per project filament (index = filament slot - 1): the tray's global id (ams * 4 + slot, 254 = the external spool), -1 = not used */
  amsMapping: number[]
  bedLeveling: boolean
  flowCali: boolean
  timelapse: boolean
}

export interface SendBegin extends SendOptions {
  printerId: string
  fileName: string
  size: number
  /** PrusaLink: where to store the file ("/usb"); empty picks the first storage that is ready */
  storage?: string
}

/** The answer to a proxied request to a printer's own web API. */
export interface HttpReply { status: number; headers: Record<string, string>; body?: string; bodyBase64?: string }

export interface RequestMap {
  auth: { req: { token: string }; res: Record<string, never> }
  pair: { req: { code: string }; res: { token: string } }
  'printers.list': { req: Record<string, never>; res: { printers: PrinterInfo[] } }
  'printers.discover': { req: Record<string, never>; res: { found: Discovered[] } }
  'printers.add': { req: AddPrinter; res: { printer: PrinterInfo } }
  'printers.remove': { req: { printerId: string }; res: Record<string, never> }
  /** Trust the certificate the printer shows now. `fingerprint` must be the one the person looked at. `which`: 'mqtt' (default), 'ftp' or 'http'. */
  'printers.trust': { req: { printerId: string; fingerprint: string; which?: 'mqtt' | 'ftp' | 'http' }; res: Record<string, never> }
  /** One request to a printer's web API through the helper, with its login added there. Only printers that were added, only a plain path. */
  'http.request': { req: { printerId: string; method?: string; path: string; headers?: Record<string, string>; body?: string }; res: HttpReply }
  'printer.pause': { req: { printerId: string }; res: Record<string, never> }
  'printer.resume': { req: { printerId: string }; res: Record<string, never> }
  'printer.stop': { req: { printerId: string }; res: Record<string, never> }
  'printer.light': { req: { printerId: string; on: boolean }; res: Record<string, never> }
  'printer.speed': { req: { printerId: string; level: 1 | 2 | 3 | 4 }; res: Record<string, never> }
  /** After the reply, send the file as binary frames (any size each) until `size` bytes are sent. Progress comes as `send` events. */
  'send.begin': { req: SendBegin; res: { jobId: string } }
  /** Works while the file is arriving and while it uploads (the upload is aborted and a partial file on the printer is deleted). */
  'send.cancel': { req: { jobId: string }; res: Record<string, never> }
}
export type RequestType = keyof RequestMap

export type Reply<T extends RequestType = RequestType> = { type: 'reply'; id: string } & RequestMap[T]['res']
export interface ErrorMsg { type: 'error'; id?: string; code: ErrorCode; message: string }

export interface Tray {
  /** global id: ams * 4 + slot, or 254 for the external spool */
  id: number
  /** 0-3 inside the unit */
  slot: number
  /** "PLA", "PETG", "" when empty */
  type: string
  /** "#RRGGBB", null when empty or unknown */
  color: string | null
  /** 0-100, -1 when the tray does not know */
  remain: number
  /** the filament's name ("Bambu PLA Basic") when the tray reports one */
  name: string
  empty: boolean
}
export interface AmsUnit {
  id: number
  /** the AMS's own 1 (wet) to 5 (dry) index, 0 when unknown */
  humidity: number
  /** percent, when the unit reports it */
  humidityPct: number | null
  temp: number | null
  trays: Tray[]
}
export interface Hms {
  code: string
  severity: 'info' | 'warn' | 'error' | 'fatal'
  text: string
  /** false when the text is only the generic line: the card then shows the code and the link */
  known: boolean
  /** Bambu's wiki page for the code */
  url: string
}
export interface Temp { cur: number; target: number }

export type PrintState = 'idle' | 'prepare' | 'running' | 'pause' | 'finish' | 'failed' | 'stopped' | 'unknown'

export interface PrinterStatus {
  printerId: string
  kind: PrinterKind
  online: boolean
  /** the helper could not log in or the certificate changed: shown instead of the live numbers. For a changed certificate it has the pinned and the presented fingerprints. */
  problem: { code: ErrorCode; message: string; oldFingerprint?: string; newFingerprint?: string } | null
  state: PrintState
  /** the printer's own state word ("RUNNING", "PRINTING", "printing", "Operational", ...) */
  gcodeState: string
  percent: number
  remainingMin: number
  layer: number
  totalLayers: number
  /** the job's name */
  file: string
  nozzle: Temp
  bed: Temp
  chamber: Temp | null
  /** 0-100; null when the printer reports no fan percent */
  fans: { part: number; aux: number; chamber: number } | null
  /** 1 silent, 2 standard, 3 sport, 4 ludicrous (Bambu) */
  speedLevel: number
  /** the speed factor in percent, for the kinds that report one */
  speedPct: number | null
  /** extra numbers a kind reports, as ready text (fan rpm, flow, height) */
  readouts: { label: string; value: string }[]
  /** null when the printer does not report a light */
  light: boolean | null
  ams: { units: AmsUnit[]; external: Tray | null; /** global id of the loaded tray, null when none */ active: number | null }
  hms: Hms[]
  /** the printer's own error number as text ("0300_4000"), '' when none; for the other kinds the printer's message */
  printError: string
  printErrorText: string
  printErrorUrl: string
  wifi: number | null
  sdcard: boolean | null
  updatedAt: number
}

export type SendStage = 'receiving' | 'uploading' | 'starting' | 'done' | 'error' | 'cancelled'
export interface SendEvent {
  type: 'send'
  jobId: string
  printerId: string
  stage: SendStage
  sent: number
  total: number
  code?: ErrorCode
  message?: string
  /** the pinned and the presented file server certificate, when the code is cert_changed */
  oldFingerprint?: string
  newFingerprint?: string
}
export interface PrintersEvent { type: 'printers'; printers: PrinterInfo[] }
export interface StatusEvent { type: 'status'; status: PrinterStatus }

export type FromHelper = HelloMsg | ErrorMsg | SendEvent | PrintersEvent | StatusEvent | (Reply & Record<string, unknown>)
export type ToHelper<T extends RequestType = RequestType> = { id: string; type: T } & RequestMap[T]['req']
