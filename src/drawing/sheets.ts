/** Sheet sizes, scales and the default title block. */
import type { DrawingDoc, DrawingSettings, Sheet, TitleBlockTemplate } from './types'

export interface SheetSize { id: string; label: string; /** landscape, mm */ w: number; h: number }

export const SHEET_SIZES: SheetSize[] = [
  { id: 'A4', label: 'A4 (297 x 210)', w: 297, h: 210 },
  { id: 'A3', label: 'A3 (420 x 297)', w: 420, h: 297 },
  { id: 'A2', label: 'A2 (594 x 420)', w: 594, h: 420 },
  { id: 'A1', label: 'A1 (841 x 594)', w: 841, h: 594 },
  { id: 'A0', label: 'A0 (1189 x 841)', w: 1189, h: 841 },
  { id: 'Letter', label: 'Letter (11 x 8.5 in)', w: 279.4, h: 215.9 },
  { id: 'Legal', label: 'Legal (14 x 8.5 in)', w: 355.6, h: 215.9 },
  { id: 'Tabloid', label: 'Tabloid (17 x 11 in)', w: 431.8, h: 279.4 },
]

export function sheetDims(s: Pick<Sheet, 'size' | 'portrait'>): { w: number; h: number } {
  const z = SHEET_SIZES.find((x) => x.id === s.size) ?? SHEET_SIZES[0]
  return s.portrait ? { w: z.h, h: z.w } : { w: z.w, h: z.h }
}

/** Preferred drawing scales as ratios (1 = 1:1, 0.5 = 1:2, 2 = 2:1). */
export const SCALES: number[] = [
  1 / 100, 1 / 50, 1 / 20, 1 / 10, 1 / 5, 1 / 2, 1, 2, 5, 10, 20, 50, 100,
]

export function scaleText(s: number): string {
  if (s >= 1) return `${trim(s)}:1`
  return `1:${trim(1 / s)}`
}
const trim = (n: number) => String(+n.toFixed(3))

/** "1:2", "2:1", "1" or "0.5" to a number, or null. */
export function parseScale(t: string): number | null {
  const m = /^\s*([\d.]+)\s*:\s*([\d.]+)\s*$/.exec(t)
  if (m) {
    const a = parseFloat(m[1]), b = parseFloat(m[2])
    return a > 0 && b > 0 ? a / b : null
  }
  const n = parseFloat(t)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** The largest preferred scale at which a w x h view fits in a w2 x h2 area. */
export function fitScale(w: number, h: number, w2: number, h2: number): number {
  const need = Math.min(w2 / Math.max(w, 1e-6), h2 / Math.max(h, 1e-6))
  let best = SCALES[0]
  for (const s of SCALES) if (s <= need * 1.0001) best = s
  return best
}

export const DEFAULT_SETTINGS: DrawingSettings = { textHeight: 3.5, arrowSize: 3, precision: 2, hatchSpacing: 2.5 }

export const DEFAULT_TEMPLATE: TitleBlockTemplate = {
  name: 'Standard',
  w: 180,
  h: 40,
  showProjection: true,
  cells: [
    { id: 'company', label: 'Company', key: 'company', x: 0, y: 28, w: 90, h: 12, size: 3.5 },
    { id: 'author', label: 'Drawn by', key: 'author', x: 90, y: 28, w: 45, h: 12, size: 3.5 },
    { id: 'date', label: 'Date', key: 'date', x: 135, y: 28, w: 45, h: 12, size: 3.5 },
    { id: 'title', label: 'Title', key: 'title', x: 0, y: 12, w: 110, h: 16, size: 5, big: true },
    { id: 'number', label: 'Drawing no.', key: 'number', x: 110, y: 12, w: 70, h: 16, size: 3.5 },
    { id: 'material', label: 'Material', key: 'material', x: 0, y: 0, w: 60, h: 12, size: 3.5 },
    { id: 'scale', label: 'Scale', key: 'scale', x: 60, y: 0, w: 30, h: 12, size: 3.5 },
    { id: 'rev', label: 'Revision', key: 'rev', x: 90, y: 0, w: 30, h: 12, size: 3.5 },
    { id: 'sheet', label: 'Sheet', key: 'sheet', x: 120, y: 0, w: 30, h: 12, size: 3.5 },
    { id: 'units', label: 'Units', key: 'units', x: 150, y: 0, w: 30, h: 12, size: 3.5 },
  ],
}

/** Values the block fills in by itself. */
export const AUTO_KEYS = ['sheet', 'scale', 'date'] as const

export function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function newSheet(id: string, name: string, over: Partial<Sheet> = {}): Sheet {
  return {
    id, name, size: 'A3', portrait: false, projection: 'third', scale: 1, margin: 10,
    titleBlock: { company: '', author: '', date: today(), title: '', number: '', material: '', rev: 'A', units: 'mm' },
    views: [], dims: [], notes: [],
    ...over,
  }
}

export function emptyDrawing(): DrawingDoc {
  return { sheets: [], active: '', template: structuredClone(DEFAULT_TEMPLATE), settings: { ...DEFAULT_SETTINGS } }
}
