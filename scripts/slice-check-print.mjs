/**
 * Slicer check for the Print workspace's 3MF export (run locally; needs OrcaSlicer, not part of CI):
 *
 *   node scripts/slice-check-print.mjs [--slicer <exe>] [--out <dir>]
 *
 * 1. Builds a three-body plate through the app's own pipeline (src/features/print/exportModel.test.ts): a block with its top face
 *    painted filament 2, a cube painted filament 3 as a whole body, a mesh slab left on filament 1; arranged on the plate with
 *    non-default print settings.
 * 2. Slices it on the slicer CLI with the Bambu A1 profiles and three filament profiles, then reads the G-code: the print settings
 *    came through, the layers reach the top of the tallest body, the extrusion lies where each body was placed, and the tool
 *    changes are real: T0, T1 and T2 all print, filament 3 only inside the cube, filament 2 only on the block's top layers,
 *    filament 1 on the slab (and the rest of the block).
 * 3. Has the slicer read the file and write it back (`--export-3mf`): names, filament per object, painted triangles and the
 *    filament colors have to survive.
 *
 * Exit code 0 when every check passes.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'

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
const filaments = model.colours.length

let failed = 0
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++ }

// ---------------------------------------------------------------- slice
// one filament profile per slot, their colors from the file; the process profile is loaded without its parents here, so the
// line widths it leaves on "auto" are given (a multi-material layer needs them)
const widths = ['line_width', 'initial_layer_line_width', 'outer_wall_line_width', 'inner_wall_line_width', 'sparse_infill_line_width', 'internal_solid_infill_line_width', 'top_surface_line_width', 'support_line_width']
const widthArgs = widths.flatMap((w) => ['--' + w.replace(/_/g, '-'), '0.42'])
const gdir = path.join(out, 'gcode')
fs.mkdirSync(gdir, { recursive: true })
const t0 = Date.now()
const sl = spawnSync(slicer, ['--slice', '0', '--outputdir', gdir, '--load-settings', settings, '--load-filaments', Array(filaments).fill(filament).join(';'), '--filament-colour', model.colours.join(';'), ...widthArgs, file], { encoding: 'utf8', timeout: 300000 })
const gfile = path.join(gdir, 'plate_1.gcode')
if (!fs.existsSync(gfile)) { console.error('Slicing failed', sl.status, sl.stdout?.slice(-1500), sl.stderr); process.exit(1) }
const gtext = fs.readFileSync(gfile, 'utf8')
const cfg = (k) => { const m = new RegExp('^; ' + k + ' = (.*)$', 'm').exec(gtext); return m ? m[1].trim() : undefined }
console.log(`sliced ${model.objects.length} objects with ${filaments} filaments in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
check(+cfg('layer_height') === model.settings.layerHeight, `layer height ${cfg('layer_height')} (wanted ${model.settings.layerHeight})`)
check(+cfg('wall_loops') === model.settings.wallLoops, `wall loops ${cfg('wall_loops')} (wanted ${model.settings.wallLoops})`)
check(cfg('sparse_infill_density') === model.settings.infill + '%', `infill ${cfg('sparse_infill_density')} (wanted ${model.settings.infill}%)`)

// ---------------------------------------------------------------- G-code with the tool in use
const segs = []
{
  let tool = 0, z = 0, x = 0, y = 0, type = '', absE = false, e = 0
  for (const raw of gtext.split(/\r?\n/)) {
    let m = /^T(\d+)\s*$/.exec(raw)
    if (m) { if (+m[1] < filaments) tool = +m[1]; continue }
    m = /^;\s*(?:Z_HEIGHT:)\s*([\d.]+)/.exec(raw)
    if (m) { z = +m[1]; continue }
    m = /^;\s*(?:TYPE|FEATURE):\s*(.*)/.exec(raw)
    if (m) { type = m[1].trim(); continue }
    if (raw.startsWith('M82')) absE = true
    if (raw.startsWith('M83')) absE = false
    if (/^G92/.test(raw)) { const em = /E(-?[\d.]+)/.exec(raw); if (em) e = +em[1]; continue }
    if (!/^G[01]\s/.test(raw)) continue
    const code = raw.split(';')[0]
    const g = (c) => { const r = new RegExp('\\b' + c + '(-?[\\d.]+)').exec(code); return r ? +r[1] : null }
    const nx = g('X') ?? x, ny = g('Y') ?? y, ne = g('E')
    let ext = 0
    if (ne !== null) { ext = absE ? ne - e : ne; if (absE) e = ne }
    if (ext > 1e-6 && (nx !== x || ny !== y)) segs.push({ tool, z, x0: x, y0: y, x1: nx, y1: ny, type, len: Math.hypot(nx - x, ny - y) })
    x = nx; y = ny
  }
}
const part = segs.filter((s) => !/skirt|brim|tower|flush/i.test(s.type))
const top = Math.max(...model.objects.map((o) => o.height))
check(Math.abs(Math.max(...part.map((s) => s.z)) - top) < model.settings.layerHeight + 1e-6, `the last layer is at z ${Math.max(...part.map((s) => s.z))} (tallest body ${top} mm)`)
const inRect = (x, y, r, pad = 0.5) => x >= r.lo[0] - pad && x <= r.hi[0] + pad && y >= r.lo[1] - pad && y <= r.hi[1] + pad
const within = (s, o) => inRect(s.x0, s.y0, o.rect) && inRect(s.x1, s.y1, o.rect)
for (const o of model.objects) {
  const n = part.filter((s) => within(s, o)).length
  check(n > 100, `${o.name}: ${n} extrusion moves inside its footprint (x ${o.rect.lo[0].toFixed(1)}..${o.rect.hi[0].toFixed(1)}, y ${o.rect.lo[1].toFixed(1)}..${o.rect.hi[1].toFixed(1)})`)
}
check(part.every((s) => model.objects.some((o) => within(s, o))), 'no extrusion outside the bodies\' footprints')

// real tool changes
const toolsUsed = [...new Set(part.map((s) => s.tool))].sort()
check(toolsUsed.join(',') === [...Array(filaments).keys()].join(','), `tools printing: T${toolsUsed.join(', T')} (wanted every filament)`)
check((gtext.match(/^M620 S\d+A/gm) || []).length >= 2 * (filaments - 1), `${(gtext.match(/^M620 S\d+A/gm) || []).length} filament swap blocks (M620) in the G-code`)
const by = (name) => model.objects.find((o) => o.name === name)
const inside = (o) => part.filter((s) => within(s, o))
const block = by('Block'), cube = by('Cube'), slab = by('Mesh slab')
const tools = (list) => [...new Set(list.map((s) => s.tool))].sort().map((t) => 'T' + t).join(',')
check(tools(inside(cube)) === 'T2', `the cube (painted filament 3 as a whole) prints with ${tools(inside(cube))}`)
check(tools(inside(slab)) === 'T0', `the unpainted slab prints with ${tools(inside(slab))}`)
const bt = inside(block)
const f2 = bt.filter((s) => s.tool === 1)
check(f2.length > 0 && bt.some((s) => s.tool === 0), `the block prints with ${tools(bt)}: filament 2 on its painted face, filament 1 elsewhere`)
const f2z = f2.map((s) => s.z)
const low = bt.filter((s) => s.z < block.height - 1.5)
check(f2z.length > 0 && Math.min(...f2z) >= block.height - 1.5 && low.every((s) => s.tool === 0), `filament 2 only in the top ${(block.height - Math.min(...f2z) + model.settings.layerHeight).toFixed(2)} mm of the block (z ${Math.min(...f2z)}..${Math.max(...f2z)}); everything under it is filament 1`)

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
