/** Minimal G-code reader for the slice check: extrusion segments per layer with their feature tag (Orca / Bambu Studio output). */
import fs from 'node:fs'

const RE_LAYER = /^;\s*(LAYER_CHANGE|CHANGE_LAYER)/
const RE_Z = /^;\s*(?:Z:|Z_HEIGHT:)\s*([\d.]+)/
const RE_TYPE = /^;\s*(?:TYPE|FEATURE):\s*(.*)/

export function parseGcode(file) {
  const layers = []
  let cur = null, x = 0, y = 0, type = '', absE = false, e = 0
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (RE_LAYER.test(raw)) { cur = { z: null, segs: [] }; layers.push(cur); continue }
    let m = RE_Z.exec(raw)
    if (m && cur) { cur.z = +m[1]; continue }
    m = RE_TYPE.exec(raw)
    if (m) { type = m[1].trim(); continue }
    if (raw.startsWith('M82')) absE = true
    if (raw.startsWith('M83')) absE = false
    if (/^G92/.test(raw)) { const em = /E(-?[\d.]+)/.exec(raw); if (em) e = +em[1]; continue }
    if (!/^G[01]\s/.test(raw)) continue
    const code = raw.split(';')[0]
    const g = (c) => { const r = new RegExp('\\b' + c + '(-?[\\d.]+)').exec(code); return r ? +r[1] : null }
    const nx = g('X') ?? x, ny = g('Y') ?? y
    const ne = g('E')
    let ext = 0
    if (ne !== null) { ext = absE ? ne - e : ne; if (absE) e = ne }
    if (ext > 1e-6 && cur && (nx !== x || ny !== y)) cur.segs.push({ x0: x, y0: y, x1: nx, y1: ny, type })
    x = nx; y = ny
  }
  return layers.filter((l) => l.z !== null)
}
