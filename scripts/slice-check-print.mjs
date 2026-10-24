/**
 * Slicer check for the Print workspace's 3MF export (run locally; needs OrcaSlicer, not part of CI):
 *
 *   node scripts/slice-check-print.mjs [--slicer <exe>] [--out <dir>]
 *
 * 1. Builds a three-body plate through the app's own pipeline (src/features/print/exportModel.test.ts): a block with one painted face,
 *    a cube painted as a whole body, a mesh slab; arranged on the plate with non-default print settings.
 * 2. Slices it on the slicer CLI with the Bambu A1 profiles and checks the G-code: the print settings came through, the layers reach the
 *    top of the tallest body, and the extrusion lies where each body was placed (and nowhere else).
 * 3. Has the slicer read the file and write it back (`--export-3mf`): names, filament per object, painted triangles and the filament
 *    colors have to survive. The CLI treats a single input file as one filament, so tool changes cannot appear in its G-code;
 *    this round trip is what shows the slicer understood the filament assignment.
 *
 * Exit code 0 when every check passes.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import { parseGcode } from './gcode.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt }
const out = path.resolve(arg('out', path.join(os.tmpdir(), 'caddy-slice-check-print')))
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const candidates = [arg('slicer'), process.env.SLICER, 'C:/Program Files/OrcaSlicer/orca-slicer.exe'].filter(Boolean)
const slicer = candidates.find((p) => fs.existsSync(p))
if (!slicer) { console.error('No slicer found. Pass --slicer <path to orca-slicer.exe>.'); process.exit(2) }
const profiles = path.join(path.dirname(slicer), 'resources', 'profiles', 'BBL')
const prof = (kind, name) => {
  const p = path.join(profiles, kind, name)
  if (!fs.existsSync(p)) throw new Error('Missing slicer profile ' + p)
  return p
}
const settings = [prof('machine', 'Bambu Lab A1 0.4 nozzle.json'), prof('process', '0.20mm Standard @BBL A1.json')].join(';')
const filament = prof('filament', 'Generic PLA @BBL A1.json')

// ---------------------------------------------------------------- model
const gen = path.join(out, 'gen')
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs')
const gr = spawnSync(process.execPath, [vitest, 'run', 'src/features/print/exportModel.test.ts'], { cwd: root, env: { ...process.env, PRINT_3MF_OUT: gen }, encoding: 'utf8' })
if (gr.status !== 0) { console.error(gr.stdout, gr.stderr); process.exit(1) }
const file = path.join(gen, 'model.3mf')
const model = JSON.parse(fs.readFileSync(path.join(gen, 'model.json'), 'utf8'))

let failed = 0
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++ }

// ---------------------------------------------------------------- slice
const gdir = path.join(out, 'gcode')
fs.mkdirSync(gdir, { recursive: true })
const t0 = Date.now()
const sl = spawnSync(slicer, ['--slice', '0', '--outputdir', gdir, '--load-settings', settings, '--load-filaments', filament, file], { encoding: 'utf8', timeout: 300000 })
const gfile = path.join(gdir, 'plate_1.gcode')
if (!fs.existsSync(gfile)) { console.error('Slicing failed', sl.status, sl.stdout, sl.stderr); process.exit(1) }
const gtext = fs.readFileSync(gfile, 'utf8')
const cfg = (k) => { const m = new RegExp('^; ' + k + ' = (.*)$', 'm').exec(gtext); return m ? m[1].trim() : undefined }
console.log(`sliced ${model.objects.length} objects in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
check(+cfg('layer_height') === model.settings.layerHeight, `layer height ${cfg('layer_height')} (wanted ${model.settings.layerHeight})`)
check(+cfg('wall_loops') === model.settings.wallLoops, `wall loops ${cfg('wall_loops')} (wanted ${model.settings.wallLoops})`)
check(cfg('sparse_infill_density') === model.settings.infill + '%', `infill ${cfg('sparse_infill_density')} (wanted ${model.settings.infill}%)`)

const layers = parseGcode(gfile)
const top = Math.max(...model.objects.map((o) => o.height))
check(Math.abs(layers[layers.length - 1].z - top) < model.settings.layerHeight + 1e-6, `the last layer is at z ${layers[layers.length - 1].z} (tallest body ${top} mm)`)

// extrusion per body footprint, perimeter / infill only
const segs = layers.flatMap((l) => l.segs).filter((s) => !/skirt|brim/i.test(s.type))
const inRect = (x, y, r, pad) => x >= r.lo[0] - pad && x <= r.hi[0] + pad && y >= r.lo[1] - pad && y <= r.hi[1] + pad
const pad = 0.5
for (const o of model.objects) {
  const n = segs.filter((s) => inRect(s.x0, s.y0, o.rect, pad) && inRect(s.x1, s.y1, o.rect, pad)).length
  check(n > 100, `${o.name}: ${n} extrusion moves inside its footprint (x ${o.rect.lo[0].toFixed(1)}..${o.rect.hi[0].toFixed(1)}, y ${o.rect.lo[1].toFixed(1)}..${o.rect.hi[1].toFixed(1)})`)
}
const stray = segs.filter((s) => !model.objects.some((o) => inRect(s.x0, s.y0, o.rect, pad) && inRect(s.x1, s.y1, o.rect, pad)))
check(stray.length === 0, `no extrusion outside the bodies' footprints (${stray.length} stray moves)`)

// ---------------------------------------------------------------- round trip
const rt = path.join(out, 'roundtrip')
fs.mkdirSync(rt, { recursive: true })
const ex = spawnSync(slicer, ['--export-3mf', 'back.3mf', '--outputdir', rt, '--load-settings', settings, file], { encoding: 'utf8', timeout: 300000 })
if (ex.status !== 0 || !fs.existsSync(path.join(rt, 'back.3mf'))) { console.error('Export through the slicer failed', ex.status); process.exit(1) }
const back = unzipSync(new Uint8Array(fs.readFileSync(path.join(rt, 'back.3mf'))))
const ms = strFromU8(back['Metadata/model_settings.config'])
const objs = [...ms.matchAll(/<object id="(\d+)">[\s\S]*?key="name" value="([^"]*)"[\s\S]*?key="extruder" value="(\d+)"/g)].map((m) => ({ name: m[2], extruder: +m[3] }))
for (const o of model.objects) {
  const got = objs.find((x) => x.name === o.name)
  check(!!got && got.extruder === o.extruder, `${o.name}: the slicer read filament ${got?.extruder} (wanted ${o.extruder})`)
}
let painted = 0
for (const [k, v] of Object.entries(back)) if (k.startsWith('3D/Objects/')) painted += (strFromU8(v).match(/paint_color="8"/g) || []).length
check(painted === model.blockSlot2Tris, `${painted} triangles painted with filament 2 survived (wanted ${model.blockSlot2Tris})`)
const colours = JSON.parse(strFromU8(back['Metadata/project_settings.config'])).filament_colour
check(JSON.stringify(colours) === JSON.stringify(model.colours), `filament colors ${JSON.stringify(colours)}`)

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
