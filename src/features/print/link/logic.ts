/** Pure helpers for the printer panel and the send dialog: model match, filament to tray matching, the AMS mapping array, time text. */
import type { PrinterInfo, PrinterStatus, PrintState, Tray } from './protocol'

/** The printer whose model matches the sliced machine preset ("Bambu Lab A1 0.4 nozzle" matches "Bambu Lab A1", not "Bambu Lab A1 mini"). */
export function modelMatches(p: Pick<PrinterInfo, 'modelLabel'>, machine: string): boolean {
  if (!p.modelLabel) return false
  const esc = p.modelLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${esc} \\d`, 'i').test(machine)
}

export function defaultPrinter(printers: PrinterInfo[], machine: string): PrinterInfo | null {
  return printers.find((p) => modelMatches(p, machine)) ?? printers[0] ?? null
}

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  const n = parseInt(h.length >= 6 ? h.slice(0, 6) : '808080', 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** sRGB to CIE Lab (D65), so the distance follows how different two colors look. */
function lab(hex: string): [number, number, number] {
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const [r, g, b] = rgb(hex).map(lin)
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047)
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b)
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

export function colorDistance(a: string, b: string): number {
  const p = lab(a), q = lab(b)
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
}

const norm = (t: string) => t.trim().toUpperCase()
/** "PLA" and "PLA+" or "PLA-CF" count as the same family; "PETG" and "PLA" do not. */
export function sameType(a: string, b: string): boolean {
  const x = norm(a), y = norm(b)
  if (!x || !y) return false
  if (x === y) return true
  const base = (t: string) => t.split(/[\s+\-_]/)[0]
  return base(x) === base(y)
}

export interface Need { slot: number; color: string; type: string }

/** Every tray of the printer a job could use: the AMS trays in order, then the external spool. */
export function trayList(s: PrinterStatus | undefined): Tray[] {
  if (!s) return []
  return [...s.ams.units.flatMap((u) => u.trays), ...(s.ams.external ? [s.ams.external] : [])]
}

/** Filament slot to tray id: same type first, then the nearest color, each tray once while there are enough. -1 = nothing fits. */
export function autoMap(needs: Need[], trays: Tray[]): Record<number, number> {
  const out: Record<number, number> = {}
  const used = new Set<number>()
  const ams = trays.filter((t) => t.id !== 254 && !t.empty)
  const ext = trays.find((t) => t.id === 254 && !t.empty)
  for (const n of needs) {
    const free = (list: Tray[]) => list.filter((t) => !used.has(t.id))
    const typed = (list: Tray[]) => list.filter((t) => sameType(t.type, n.type))
    const near = (list: Tray[]) => [...list].sort((a, b) => colorDistance(n.color, a.color ?? '#808080') - colorDistance(n.color, b.color ?? '#808080'))[0]
    const chosen = near(typed(free(ams))) ?? near(typed(ams)) ?? near(free(ams)) ?? near(ams) ?? ext
    out[n.slot] = chosen ? chosen.id : -1
    if (chosen) used.add(chosen.id)
  }
  return out
}

/** The array the helper sends in `ams_mapping`: index = filament slot - 1, the tray id, -1 for a filament the job does not use. */
export function mappingArray(assign: Record<number, number>, needs: Need[]): number[] {
  const top = Math.max(0, ...needs.map((n) => n.slot))
  const arr = Array.from({ length: top }, () => -1)
  for (const n of needs) arr[n.slot - 1] = assign[n.slot] ?? -1
  return arr
}

export function trayLabel(t: Tray): string {
  if (t.id === 254) return 'External spool'
  return `AMS ${Math.floor(t.id / 4) + 1} slot ${t.slot + 1}`
}

export function durationText(min: number): string {
  if (!(min > 0)) return ''
  const h = Math.floor(min / 60), m = Math.round(min % 60)
  return h > 0 ? `${h} h ${m} min` : `${m} min`
}

/** The clock time a job ends, from the minutes left. */
export function etaText(min: number, now = Date.now()): string {
  if (!(min > 0)) return ''
  return new Date(now + min * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export const STATE_LABEL: Record<PrintState, string> = { idle: 'Ready', prepare: 'Preparing', running: 'Printing', pause: 'Paused', finish: 'Finished', failed: 'Failed', unknown: 'Unknown' }

/** A job is in progress (Pause and Stop make sense). */
export const isActive = (s: PrintState) => s === 'running' || s === 'prepare' || s === 'pause'

export const HUMIDITY: Record<number, string> = { 1: 'Very humid', 2: 'Humid', 3: 'Fair', 4: 'Dry', 5: 'Very dry' }

/** The errors the panel can show, in plain words. */
export function plainLinkError(code: string, message: string): string {
  switch (code) {
    case 'bad_access_code': return 'The access code was not accepted. Check it on the printer screen.'
    case 'unreachable': return 'The printer could not be reached. Check the IP address and that it is on the same network.'
    case 'cert_changed': return 'The printer presented a different security certificate than before. Remove it and add it again if you trust the change.'
    case 'dev_mode': return 'The printer refused the command. Turn on Developer Mode (under LAN Only mode) on the printer.'
    case 'sd_missing': return 'The printer has no storage card to hold the file. Insert an SD card.'
    case 'busy': return 'The printer is busy with another job.'
    case 'offline': return 'The printer is offline.'
    default: return message
  }
}
