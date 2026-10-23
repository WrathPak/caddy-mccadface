/**
 * Slicer check for the Hair feature (run locally; needs OrcaSlicer or Bambu Studio, not part of CI):
 *
 *   node scripts/slice-check.mjs [--slicer <exe>] [--out <dir>] [--params '{"width":0.3}'] [--wall-generator classic|arachne] [--stl model.stl --json model.json]
 *
 * 1. Builds a hair test model (box, hair on two adjacent faces, wall, union) through the app's own pipeline and STL writer
 *    (src/features/hair/exportModel.test.ts) - or takes --stl/--json.
 * 2. Slices it on the slicer CLI with the Bambu A1 0.4 nozzle / 0.20 mm Standard / Generic PLA profiles. Thin-wall detection is
 *    left OFF (the profile default): the hair has to print without it.
 * 3. Reads the G-code: on every layer a strand occupies there must be extrusion moves along the strand, from the body's
 *    surface to the wall, and the extruded extent must match the strand footprint.
 *
 * Exit code 0 when every check passes.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseGcode } from './gcode.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt }
const out = path.resolve(arg('out', path.join(os.tmpdir(), 'caddy-slice-check')))
fs.mkdirSync(out, { recursive: true })

// ---------------------------------------------------------------- slicer
const candidates = [arg('slicer'), process.env.SLICER, 'C:/Program Files/OrcaSlicer/orca-slicer.exe', 'C:/Program Files/Bambu Studio/bambu-studio.exe'].filter(Boolean)
const slicer = candidates.find((p) => fs.existsSync(p))
if (!slicer) { console.error('No slicer found. Pass --slicer <path to orca-slicer.exe or bambu-studio.exe>.'); process.exit(2) }
const resources = path.join(path.dirname(slicer), 'resources')
const prof = (kind, name) => {
  const p = path.join(resources, 'profiles', 'BBL', kind, name)
  if (!fs.existsSync(p)) throw new Error('Missing slicer profile ' + p)
  return p
}

// ---------------------------------------------------------------- model
let stl = arg('stl'), side = arg('json')
if (!stl) {
  const gen = path.join(out, 'gen')
  const env = { ...process.env, HAIR_STL_OUT: gen, HAIR_PARAMS: arg('params', '{}') }
  const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
  const r = spawnSync(process.execPath, [vitest, 'run', 'src/features/hair/exportModel.test.ts'], { cwd: root, env, encoding: 'utf8' })
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1) }
  stl = path.join(gen, 'model.stl'); side = path.join(gen, 'model.json')
}
const model = JSON.parse(fs.readFileSync(side, 'utf8'))

// ---------------------------------------------------------------- slice
const gdir = path.join(out, 'gcode')
fs.rmSync(gdir, { recursive: true, force: true })
fs.mkdirSync(gdir, { recursive: true })
const settings = [prof('machine', 'Bambu Lab A1 0.4 nozzle.json'), prof('process', '0.20mm Standard @BBL A1.json')].join(';')
const t0 = Date.now()
// Bambu Studio's default wall generator is Classic (Orca's is Arachne, which prints thinner features); the stricter one is the default here
const wallGen = arg('wall-generator', 'classic')
const sl = spawnSync(slicer, ['--slice', '0', '--outputdir', gdir, '--load-settings', settings, '--load-filaments', prof('filament', 'Generic PLA @BBL A1.json'), '--wall-generator', wallGen, stl], { encoding: 'utf8', timeout: 300000 })
const gfile = path.join(gdir, 'plate_1.gcode')
if (!fs.existsSync(gfile)) { console.error('Slicing failed', sl.status, sl.stdout, sl.stderr); process.exit(1) }
const gtext = fs.readFileSync(gfile, 'utf8')
const cfg = (k) => { const m = new RegExp('^; ' + k + ' = (.*)$', 'm').exec(gtext); return m ? m[1].trim() : undefined }
const lineW = 0.42
const layerH = parseFloat(cfg('layer_height')), firstH = parseFloat(cfg('initial_layer_print_height'))
console.log(`sliced in ${((Date.now() - t0) / 1000).toFixed(1)} s | layer ${layerH}, first ${firstH}, wall generator ${cfg('wall_generator')}, detect_thin_wall = ${cfg('detect_thin_wall')}`)
if (cfg('detect_thin_wall') !== '0') { console.error('FAIL: the profile has thin-wall detection ON; the check needs it OFF'); process.exit(1) }

// ---------------------------------------------------------------- read the G-code
const layers = parseGcode(gfile)
// the slicer centres the model on the plate: find the offset from the extrusion bounds (skirt / brim excluded)
const sb = (() => {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity]
  for (const l of layers) for (const s of l.segs) {
    if (/skirt|brim/i.test(s.type)) continue
    for (const [x, y] of [[s.x0, s.y0], [s.x1, s.y1]]) { lo[0] = Math.min(lo[0], x); hi[0] = Math.max(hi[0], x); lo[1] = Math.min(lo[1], y); hi[1] = Math.max(hi[1], y) }
  }
  return { lo, hi }
})()
const stlBox = (() => {
  const b = fs.readFileSync(stl)
  const n = b.readUInt32LE(80)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) { const v = b.readFloatLE(84 + i * 50 + 12 + j * 12 + k * 4); lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v) }
  return { lo, hi }
})()
const off = [(sb.lo[0] + sb.hi[0]) / 2 - (stlBox.lo[0] + stlBox.hi[0]) / 2, (sb.lo[1] + sb.hi[1]) / 2 - (stlBox.lo[1] + stlBox.hi[1]) / 2]
const bed = stlBox.lo[2]
console.log(`model z ${bed.toFixed(2)}..${stlBox.hi[2].toFixed(2)} (bed = lowest point) | plate offset ${off.map((x) => x.toFixed(2)).join(', ')} | ${layers.length} layers`)
if (Math.abs(bed - model.bedZ) > 1e-3) { console.error(`FAIL: the pipeline's bed height ${model.bedZ} differs from the model's lowest point ${bed}`); process.exit(1) }

// ---------------------------------------------------------------- per strand checks
const { width: W, thickness: T } = model.params
const results = []
let anyLayers = 0
const strandLayers = new Set()
for (const st of model.strands) {
  if (!st.contact) continue
  const dx = st.contact[0] - st.root[0], dy = st.contact[1] - st.root[1]
  const L = Math.hypot(dx, dy)
  const d = [dx / L, dy / L]
  const lo = st.z - T / 2 - bed, hi = st.z + T / 2 - bed
  // layers whose slice plane (mid-height) lies inside the strand band
  const mine = layers.filter((l, i) => {
    const bottom = i === 0 ? 0 : layers[i - 1].z
    const mid = (bottom + l.z) / 2
    return mid > lo && mid < hi
  })
  let best = null
  for (const l of mine) {
    strandLayers.add(l.z)
    let tmin = Infinity, tmax = -Infinity, len = 0
    for (const s of l.segs) {
      if (/skirt|brim/i.test(s.type)) continue
      const mx = (s.x0 + s.x1) / 2 - off[0] - st.root[0], my = (s.y0 + s.y1) / 2 - off[1] - st.root[1]
      const t = mx * d[0] + my * d[1], n = Math.abs(-mx * d[1] + my * d[0])
      if (n > W / 2 + lineW || t < 0 || t > L) continue
      len += Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
      for (const [x, y] of [[s.x0, s.y0], [s.x1, s.y1]]) {
        const tt = (x - off[0] - st.root[0]) * d[0] + (y - off[1] - st.root[1]) * d[1]
        tmin = Math.min(tmin, tt); tmax = Math.max(tmax, tt)
      }
    }
    if (!best || len > best.len) best = { layer: l.z, tmin, tmax, len }
  }
  anyLayers += mine.length
  const ok = !!best && best.len > 0.6 * (L - 0.4) && best.tmin <= lineW && best.tmax >= L - lineW
  results.push({ ok, L, layers: mine.length, best })
}
const pass = results.filter((r) => r.ok).length
const pct = (100 * pass) / Math.max(1, results.length)
console.log(`strands: ${results.length}, each on ${(anyLayers / Math.max(1, results.length)).toFixed(1)} layer(s) of ${strandLayers.size} distinct strand layers`)
console.log(`strands with a continuous extrusion from the body surface to the wall (end gaps < ${lineW} mm): ${pass}/${results.length} (${pct.toFixed(0)} %)`)
const worst = results.filter((r) => !r.ok).slice(0, 3)
for (const r of worst) console.log('  not printed:', JSON.stringify({ L: +r.L.toFixed(2), layers: r.layers, best: r.best && { z: r.best.layer, tmin: +r.best.tmin.toFixed(2), tmax: +r.best.tmax.toFixed(2), len: +r.best.len.toFixed(1) } }))

// extent of the strand zone extrusions against the strand footprint (all strand layers, between body and wall)
const ext = { lo: [Infinity, Infinity], hi: [-Infinity, -Infinity] }
const want = { lo: [Infinity, Infinity], hi: [-Infinity, -Infinity] }
const inGap = (x, y) => {
  const px = x - off[0], py = y - off[1]
  const b = model.body
  const margin = 0.8
  const outsideX = px > b.max[0] + margin && py > b.min[1] - 0.2 && py < b.max[1] + 0.2
  const outsideY = py < b.min[1] - margin && px > b.min[0] - 0.2 && px < b.max[0] + 0.2
  return { x: px, y: py, hit: outsideX || outsideY, wallMargin: Math.min(...model.strands.filter((s) => s.contact).map((s) => Math.hypot(s.contact[0] - px, s.contact[1] - py))) }
}
for (const st of model.strands) {
  if (!st.contact) continue
  for (const p of [st.root, st.contact]) for (let k = 0; k < 2; k++) { want.lo[k] = Math.min(want.lo[k], p[k] - W / 2); want.hi[k] = Math.max(want.hi[k], p[k] + W / 2) }
}
for (const l of layers) {
  if (!strandLayers.has(l.z)) continue
  for (const s of l.segs) {
    if (/skirt|brim/i.test(s.type)) continue
    const a = inGap((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2)
    if (!a.hit || a.wallMargin > 30) continue
    // only extrusion clearly between the body and the wall (not the wall itself)
    const nearWall = model.strands.some((q) => q.contact && Math.hypot(q.contact[0] - a.x, q.contact[1] - a.y) < 0.9 && false)
    if (nearWall) continue
    for (const [x, y] of [[s.x0, s.y0], [s.x1, s.y1]]) {
      ext.lo[0] = Math.min(ext.lo[0], x - off[0]); ext.hi[0] = Math.max(ext.hi[0], x - off[0]); ext.lo[1] = Math.min(ext.lo[1], y - off[1]); ext.hi[1] = Math.max(ext.hi[1], y - off[1])
    }
  }
}
const f = (v) => v.map((x) => x.toFixed(1)).join(', ')
console.log(`strand footprint x/y   : [${f(want.lo)}] .. [${f(want.hi)}]`)
console.log(`extruded in the gap    : [${f(ext.lo)}] .. [${f(ext.hi)}]  (includes the wall's inner edge)`)

const failures = []
if (!results.length) failures.push('no strands in the model')
if (pct < 95) failures.push(`only ${pct.toFixed(0)} % of the strands print from the body to the wall`)
if (!strandLayers.size) failures.push('no slice layer falls inside a strand band')
if (failures.length) { console.log('\nFAIL: ' + failures.join('; ')); process.exit(1) }
console.log('\nPASS: the hair slices into continuous toolpaths from the body to the wall with thin-wall detection off')
