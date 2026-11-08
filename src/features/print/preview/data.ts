/** Pure parts of the layer preview: size codes, chunk plan, value ramps, per-feature stats, the bed to world move. No three.js here. */
import type { ToolpathExtras, Toolpaths } from '@muon3d/slicer-engine-protocol'

/** Line width and bead height size codes (0.01 mm steps to 2 mm = 200, then 0.05 mm steps to 4.75 mm = 255; 0 unknown) as mm. */
export const sizeMm = (code: number): number => (code <= 200 ? code * 0.01 : 2 + (code - 200) * 0.05)

export interface Chunk {
  /** first segment (global index) and one past the last */
  start: number
  end: number
  /** layers this chunk touches, inclusive */
  layerLo: number
  layerHi: number
}

/**
 * Split the segments into runs of about `target`, cutting at layer starts so a layer range mostly maps to whole chunks.
 * A layer bigger than the target is cut in the middle (several chunks then share a layer).
 */
export function planChunks(layerStart: Uint32Array, target = 120_000): Chunk[] {
  const layers = layerStart.length - 1
  const out: Chunk[] = []
  if (layers <= 0) return out
  const total = layerStart[layers]
  let start = 0
  let layer = 0
  while (start < total) {
    while (layer < layers && layerStart[layer + 1] <= start) layer++
    if (layer >= layers) break
    let end = start
    let l = layer
    while (l < layers && layerStart[l + 1] - start <= target) { end = layerStart[l + 1]; l++ }
    if (end === start) {
      // one layer alone is bigger than the target: cut it
      end = Math.min(layerStart[layer + 1], start + target)
      out.push({ start, end, layerLo: layer, layerHi: layer })
    } else {
      out.push({ start, end, layerLo: layer, layerHi: l - 1 })
    }
    start = end
  }
  return out
}

/** The layer a global segment index belongs to. */
export function layerOfSegment(layerStart: Uint32Array, seg: number): number {
  let lo = 0, hi = layerStart.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (layerStart[mid] <= seg) lo = mid
    else hi = mid - 1
  }
  return lo
}

export interface ViewRange {
  /** bottom and top layer shown (0-based, inclusive) */
  lo: number
  hi: number
  /** 0..1 of the top layer's segments drawn (1 = all) */
  scrub: number
}

/** The global segment range drawn for a layer range and a scrub position. */
export function segmentRange(layerStart: Uint32Array, r: ViewRange): [number, number] {
  const layers = layerStart.length - 1
  const lo = Math.max(0, Math.min(layers - 1, r.lo))
  const hi = Math.max(lo, Math.min(layers - 1, r.hi))
  const a = layerStart[lo]
  const topStart = layerStart[hi]
  const topEnd = layerStart[hi + 1]
  const b = r.scrub >= 1 ? topEnd : topStart + Math.round((topEnd - topStart) * Math.max(0, r.scrub))
  return [a, b]
}

export interface Visible { segments: number; layers: number; first: number; last: number }

/** How many segments pass the layer range, the scrub position and the feature / filament switches: what the GPU draws. */
export function countVisible(tp: Toolpaths, r: ViewRange, roleOn: ArrayLike<boolean>, filament?: Uint8Array | null, filOn?: ArrayLike<boolean>): Visible {
  const [a, b] = segmentRange(tp.extrusions.layerStart, r)
  const ri = tp.extrusions.roleIndex
  let n = 0
  for (let i = a; i < b; i++) {
    if (!roleOn[ri[i]]) continue
    if (filament && filOn && !filOn[filament[i]]) continue
    n++
  }
  const lo = Math.max(0, Math.min(tp.layerCount - 1, r.lo))
  const hi = Math.max(lo, Math.min(tp.layerCount - 1, r.hi))
  return { segments: n, layers: hi - lo + 1, first: a, last: b }
}

/** Bed coordinates (origin at the printable area's front-left, +Z up from the plate) to the app's world. */
export const bedToWorld = (p: readonly [number, number, number], origin: readonly [number, number, number]): [number, number, number] =>
  [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]]

/**
 * Where bed (0,0,0) sits in the world when the slice did not say: the bed is centered on the bodies' bounding box
 * (what the slice does for placement "keep" and for a single body) and rests on the lowest point.
 */
export function bedOriginFromBounds(lo: readonly number[], hi: readonly number[], bed: readonly [number, number]): [number, number, number] {
  return [(lo[0] + hi[0]) / 2 - bed[0] / 2, (lo[1] + hi[1]) / 2 - bed[1] / 2, lo[2]]
}

// ---- value ramps

export type ColorMode = 'feature' | 'filament' | 'width' | 'speed' | 'fan' | 'temperature' | 'layerTime'

export const MODE_LABEL: Record<ColorMode, string> = {
  feature: 'Feature type', filament: 'Filament', width: 'Line width', speed: 'Speed', fan: 'Fan speed', temperature: 'Temperature', layerTime: 'Layer time',
}
export const MODE_UNIT: Record<ColorMode, string> = { feature: '', filament: '', width: 'mm', speed: 'mm/s', fan: '%', temperature: '°C', layerTime: 's' }
export const EXTRAS_MODES: ColorMode[] = ['speed', 'fan', 'temperature', 'layerTime']

/** Orca's range colors, cold to hot. */
export const RAMP: [number, number, number][] = [
  [0.043, 0.173, 0.478], [0.075, 0.349, 0.557], [0.110, 0.533, 0.569], [0.016, 0.839, 0.059], [0.667, 0.949, 0.0],
  [0.988, 0.975, 0.012], [0.961, 0.808, 0.039], [0.89, 0.412, 0.012], [0.82, 0.231, 0.043], [0.757, 0.188, 0.102],
]

export const rampAt = (t: number): [number, number, number] => {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(x))
  const f = x - i
  return [0, 1, 2].map((k) => RAMP[i][k] + (RAMP[i + 1][k] - RAMP[i][k]) * f) as [number, number, number]
}
export const rampCss = () => `linear-gradient(90deg, ${RAMP.map((c, i) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')}) ${Math.round((i / (RAMP.length - 1)) * 100)}%`).join(', ')})`

export interface ValueSet {
  /** one byte per segment: the value scaled to 0..255 over [min, max] */
  bytes: Uint8Array
  min: number
  max: number
}

/** Per-layer time in seconds: the print clock at the end of each layer minus the end of the one before. */
export function layerTimes(tp: Toolpaths, extras: ToolpathExtras): Float32Array {
  const ls = tp.extrusions.layerStart
  const out = new Float32Array(tp.layerCount)
  let prev = 0
  for (let l = 0; l < tp.layerCount; l++) {
    const end = ls[l + 1] > ls[l] ? extras.time[ls[l + 1] - 1] : prev
    out[l] = Math.max(0, end - prev)
    prev = end
  }
  return out
}

const scaleBytes = (n: number, get: (i: number) => number): ValueSet => {
  let min = Infinity, max = -Infinity
  for (let i = 0; i < n; i++) { const v = get(i); if (v < min) min = v; if (v > max) max = v }
  if (!isFinite(min)) { min = 0; max = 0 }
  const bytes = new Uint8Array(n)
  const span = max - min
  if (span > 1e-9) for (let i = 0; i < n; i++) bytes[i] = Math.round(((get(i) - min) / span) * 255)
  return { bytes, min, max }
}

/** The value a continuous color mode paints, as bytes. Null when the data for it is missing. */
export function valueSet(mode: ColorMode, tp: Toolpaths, extras: ToolpathExtras | null): ValueSet | null {
  const n = tp.extrusions.count
  switch (mode) {
    case 'width': { const w = tp.extrusions.width; return scaleBytes(n, (i) => (w[i] ? sizeMm(w[i]) : tp.lineWidth ?? 0.4)) }
    case 'speed': return extras ? scaleBytes(n, (i) => extras.feedrate[i]) : null
    case 'fan': return extras ? scaleBytes(n, (i) => extras.fanSpeed[i]) : null
    case 'temperature': return extras ? scaleBytes(n, (i) => extras.temperature[i]) : null
    case 'layerTime': {
      if (!extras) return null
      const lt = layerTimes(tp, extras)
      const ls = tp.extrusions.layerStart
      const per = new Float32Array(n)
      for (let l = 0; l < tp.layerCount; l++) for (let i = ls[l]; i < ls[l + 1]; i++) per[i] = lt[l]
      return scaleBytes(n, (i) => per[i])
    }
    default: return null
  }
}

// ---- stats for the legend

export interface RoleStat { name: string; lengthMm: number; lengthShare: number; seconds: number | null; timeShare: number | null }

/** Length and (with extras) time per feature. A segment's time is the clock step to its end, which includes the travel before it. */
export function roleStats(tp: Toolpaths, extras: ToolpathExtras | null): RoleStat[] {
  const total = tp.roles.reduce((s, r) => s + r.lengthMm, 0) || 1
  const secs = new Float64Array(tp.roles.length)
  if (extras) {
    const ri = tp.extrusions.roleIndex
    let prev = 0
    for (let i = 0; i < tp.extrusions.count; i++) {
      const t = extras.time[i]
      secs[ri[i]] += Math.max(0, t - prev)
      prev = t
    }
  }
  const secTotal = secs.reduce((a, b) => a + b, 0)
  return tp.roles.map((r, i) => ({
    name: r.name,
    lengthMm: r.lengthMm,
    lengthShare: r.lengthMm / total,
    seconds: extras ? secs[i] : null,
    timeShare: extras && secTotal > 0 ? secs[i] / secTotal : null,
  }))
}

export const fmtTime = (s: number): string => {
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(Math.round(s - m * 60)).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m - h * 60).padStart(2, '0')}m`
}
export const fmtLength = (mm: number): string => (mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`)
export const fmtPct = (f: number): string => (f > 0 && f < 0.001 ? '<0.1%' : `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`)
