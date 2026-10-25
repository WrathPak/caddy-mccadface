/** Vector glyphs for the geometric tolerance symbols, drawn in a unit square (0..1, y up). */
import type { GdtSymbol } from './types'

export interface Glyph { /** open or closed polylines, flat [x, y, ...] */ paths: { pts: number[]; closed?: boolean; fill?: boolean }[] }

const circle = (cx: number, cy: number, r: number, n = 36): number[] => {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI))
  return out
}
const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 20): number[] => {
  const out: number[] = []
  for (let i = 0; i <= n; i++) {
    const t = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    out.push(cx + r * Math.cos(t), cy + r * Math.sin(t))
  }
  return out
}
const head = (x: number, y: number, dx: number, dy: number, s = 0.16): { pts: number[]; closed: boolean; fill: boolean } => {
  const l = Math.hypot(dx, dy) || 1
  const ux = dx / l, uy = dy / l
  const bx = x - ux * s, by = y - uy * s
  return { pts: [x, y, bx - uy * s * 0.35, by + ux * s * 0.35, bx + uy * s * 0.35, by - ux * s * 0.35], closed: true, fill: true }
}

export const GDT_GLYPHS: Record<GdtSymbol, Glyph> = {
  straightness: { paths: [{ pts: [0.15, 0.5, 0.85, 0.5] }] },
  flatness: { paths: [{ pts: [0.22, 0.3, 0.95, 0.3, 0.78, 0.7, 0.05, 0.7], closed: true }] },
  circularity: { paths: [{ pts: circle(0.5, 0.5, 0.3), closed: true }] },
  cylindricity: { paths: [{ pts: circle(0.5, 0.5, 0.2), closed: true }, { pts: [0.2, 0.18, 0.38, 0.82] }, { pts: [0.62, 0.18, 0.8, 0.82] }] },
  lineProfile: { paths: [{ pts: arc(0.5, 0.32, 0.34, 0, 180) }] },
  surfaceProfile: { paths: [{ pts: [...arc(0.5, 0.32, 0.34, 0, 180)], closed: true }] },
  parallelism: { paths: [{ pts: [0.22, 0.15, 0.47, 0.85] }, { pts: [0.5, 0.15, 0.75, 0.85] }] },
  perpendicularity: { paths: [{ pts: [0.12, 0.15, 0.88, 0.15] }, { pts: [0.5, 0.15, 0.5, 0.85] }] },
  angularity: { paths: [{ pts: [0.12, 0.15, 0.88, 0.15] }, { pts: [0.12, 0.15, 0.62, 0.85] }] },
  position: { paths: [{ pts: circle(0.5, 0.5, 0.28), closed: true }, { pts: [0.5, 0.1, 0.5, 0.9] }, { pts: [0.1, 0.5, 0.9, 0.5] }] },
  concentricity: { paths: [{ pts: circle(0.5, 0.5, 0.14), closed: true }, { pts: circle(0.5, 0.5, 0.3), closed: true }] },
  symmetry: { paths: [{ pts: [0.12, 0.5, 0.88, 0.5] }, { pts: [0.28, 0.28, 0.72, 0.28] }, { pts: [0.28, 0.72, 0.72, 0.72] }] },
  runout: { paths: [{ pts: [0.2, 0.18, 0.76, 0.78] }, head(0.82, 0.84, 0.56, 0.6)] },
  totalRunout: { paths: [{ pts: [0.12, 0.18, 0.48, 0.74] }, head(0.54, 0.84, 0.36, 0.56), { pts: [0.42, 0.18, 0.78, 0.74] }, head(0.84, 0.84, 0.36, 0.56)] },
}

export const GDT_LABELS: Record<GdtSymbol, string> = {
  straightness: 'Straightness', flatness: 'Flatness', circularity: 'Circularity', cylindricity: 'Cylindricity',
  lineProfile: 'Profile of a line', surfaceProfile: 'Profile of a surface', parallelism: 'Parallelism', perpendicularity: 'Perpendicularity',
  angularity: 'Angularity', position: 'Position', concentricity: 'Concentricity', symmetry: 'Symmetry', runout: 'Circular runout', totalRunout: 'Total runout',
}
