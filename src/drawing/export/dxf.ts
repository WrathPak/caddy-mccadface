/** DXF output of a sheet (AutoCAD R12 ASCII, millimetres): polylines on layers with linetypes, TEXT, and SOLID arrowheads. */
import { LINE_STYLES } from '../styles'
import type { LineStyle, Prim } from '../types'

const num = (v: number) => (Math.abs(v) < 1e-9 ? '0' : String(+v.toFixed(5)))

class Writer {
  private lines: string[] = []
  g(code: number, value: string | number) {
    this.lines.push(String(code), typeof value === 'number' ? num(value) : value)
  }
  toString() {
    return this.lines.join('\r\n') + '\r\n'
  }
}

const LTYPES: Record<string, { desc: string; pattern: number[] }> = {
  HIDDEN: { desc: 'Hidden __ __ __ __', pattern: [3, -1.5] },
  CENTER: { desc: 'Center ____ _ ____ _', pattern: [10, -1.5, 1.5, -1.5] },
  PHANTOM: { desc: 'Phantom ____ _ _ ____', pattern: [12, -2, 2, -2, 2, -2] },
}

export function sheetToDxf(prims: Prim[], w: number, h: number): string {
  const d = new Writer()
  const layers = new Map<string, { aci: number; ltype: string }>()
  for (const s of Object.values(LINE_STYLES)) layers.set(s.layer, { aci: s.aci, ltype: s.ltype })
  layers.set('TEXT', { aci: 7, ltype: 'CONTINUOUS' })

  d.g(0, 'SECTION'); d.g(2, 'HEADER')
  d.g(9, '$ACADVER'); d.g(1, 'AC1009')
  d.g(9, '$INSUNITS'); d.g(70, 4)
  d.g(9, '$EXTMIN'); d.g(10, 0); d.g(20, 0)
  d.g(9, '$EXTMAX'); d.g(10, w); d.g(20, h)
  d.g(0, 'ENDSEC')

  d.g(0, 'SECTION'); d.g(2, 'TABLES')
  d.g(0, 'TABLE'); d.g(2, 'LTYPE'); d.g(70, Object.keys(LTYPES).length + 1)
  d.g(0, 'LTYPE'); d.g(2, 'CONTINUOUS'); d.g(70, 0); d.g(3, 'Solid line'); d.g(72, 65); d.g(73, 0); d.g(40, 0)
  for (const [name, lt] of Object.entries(LTYPES)) {
    d.g(0, 'LTYPE'); d.g(2, name); d.g(70, 0); d.g(3, lt.desc); d.g(72, 65); d.g(73, lt.pattern.length)
    d.g(40, lt.pattern.reduce((s, x) => s + Math.abs(x), 0))
    for (const x of lt.pattern) d.g(49, x)
  }
  d.g(0, 'ENDTAB')
  d.g(0, 'TABLE'); d.g(2, 'LAYER'); d.g(70, layers.size)
  for (const [name, l] of layers) { d.g(0, 'LAYER'); d.g(2, name); d.g(70, 0); d.g(62, l.aci); d.g(6, l.ltype) }
  d.g(0, 'ENDTAB')
  d.g(0, 'TABLE'); d.g(2, 'STYLE'); d.g(70, 1)
  d.g(0, 'STYLE'); d.g(2, 'STANDARD'); d.g(70, 0); d.g(40, 0); d.g(41, 1); d.g(50, 0); d.g(71, 0); d.g(42, 2.5); d.g(3, 'txt'); d.g(4, '')
  d.g(0, 'ENDTAB')
  d.g(0, 'ENDSEC')

  d.g(0, 'SECTION'); d.g(2, 'ENTITIES')
  for (const p of prims) {
    if (p.k === 'path') {
      if (p.pick || p.pts.length < 4) continue
      const spec = LINE_STYLES[p.style as LineStyle]
      if (p.fill === 'solid' && p.pts.length === 6) {
        // arrowhead: a solid triangle (the fourth corner repeats the third)
        d.g(0, 'SOLID'); d.g(8, spec.layer)
        const q = p.pts
        d.g(10, q[0]); d.g(20, q[1]); d.g(30, 0)
        d.g(11, q[2]); d.g(21, q[3]); d.g(31, 0)
        d.g(12, q[4]); d.g(22, q[5]); d.g(32, 0)
        d.g(13, q[4]); d.g(23, q[5]); d.g(33, 0)
        continue
      }
      d.g(0, 'POLYLINE'); d.g(8, spec.layer); d.g(66, 1); d.g(70, p.closed ? 1 : 0)
      if (spec.width > 0.3) { d.g(40, spec.width); d.g(41, spec.width) }
      for (let i = 0; i < p.pts.length; i += 2) { d.g(0, 'VERTEX'); d.g(8, spec.layer); d.g(10, p.pts[i]); d.g(20, p.pts[i + 1]); d.g(30, 0) }
      d.g(0, 'SEQEND'); d.g(8, spec.layer)
    } else {
      d.g(0, 'TEXT'); d.g(8, 'TEXT')
      d.g(10, p.x); d.g(20, p.y); d.g(30, 0)
      d.g(40, p.size)
      d.g(1, p.text)
      if (p.rot) d.g(50, p.rot)
      d.g(7, 'STANDARD')
      if (p.anchor !== 'start') {
        d.g(72, p.anchor === 'middle' ? 1 : 2)
        d.g(11, p.x); d.g(21, p.y); d.g(31, 0)
      }
    }
  }
  d.g(0, 'ENDSEC')
  d.g(0, 'EOF')
  return d.toString()
}

/** Counts of the entities in a DXF text, for checks. */
export function dxfEntityCounts(dxf: string): Record<string, number> {
  const lines = dxf.split(/\r?\n/)
  const out: Record<string, number> = {}
  let inEntities = false
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() === '0') {
      const v = lines[i + 1].trim()
      if (v === 'SECTION') continue
      if (v === 'ENDSEC') inEntities = false
      else if (inEntities) out[v] = (out[v] ?? 0) + 1
    }
    if (lines[i].trim() === '2' && lines[i + 1].trim() === 'ENTITIES') inEntities = true
  }
  return out
}
