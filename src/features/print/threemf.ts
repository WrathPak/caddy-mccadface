/**
 * Bambu Studio / OrcaSlicer 3MF: one object per body with its name, an item per object placed on the build plate,
 * filament slots (a whole-object extruder, plus per-triangle `paint_color` for painted faces) and the print settings as
 * `Metadata/project_settings.config`. Plain 3MF readers still see ordinary mesh objects.
 */
import { strToU8, zipSync } from 'fflate'
import { FILAMENT_DEFAULTS } from './filamentDefaults'
import { colorById } from './palette'
import type { PrintSettings } from './settings'

export interface PlateObject {
  name: string
  positions: Float32Array
  indices: Uint32Array
  /** filament slot per triangle (1-based), 0 = unpainted */
  slots?: Uint8Array
}

export interface Placement { offset: [number, number, number] }

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
const num = (n: number) => String(+n.toFixed(6))

/** The `paint_color` value the slicers use for filament `slot` (1-based): one nibble for 1 and 2, then a 'C' marker with the rest. */
export function paintColorCode(slot: number): string {
  if (slot <= 0) return ''
  if (slot === 1) return '4'
  if (slot === 2) return '8'
  return (slot - 3).toString(16).toUpperCase() + 'C'
}

/** Inverse of `paintColorCode`, for reading files back in tests. */
export function slotFromPaintCode(code: string): number {
  if (code === '4') return 1
  if (code === '8') return 2
  const m = /^([0-9A-F])C$/.exec(code)
  return m ? parseInt(m[1], 16) + 3 : 0
}

export interface ObjectSlots {
  /** filament the object prints in unless a triangle says otherwise */
  extruder: number
  /** triangles that differ from it (index -> slot) */
  tris: Map<number, number>
}

/** Split a triangle slot list into the object's default filament and the triangles that differ from it. */
export function objectSlots(slots: Uint8Array | undefined, triCount: number): ObjectSlots {
  if (!slots || !slots.some((s) => s)) return { extruder: 1, tris: new Map() }
  // a body painted as a whole prints in that filament without any per-triangle data
  const counts = new Map<number, number>()
  for (let t = 0; t < triCount; t++) counts.set(slots[t] || 1, (counts.get(slots[t] || 1) ?? 0) + 1)
  let extruder = 1, best = -1
  for (const [s, c] of counts) if (c > best) { best = c; extruder = s }
  const tris = new Map<number, number>()
  for (let t = 0; t < triCount; t++) {
    const s = slots[t] || 1
    if (s !== extruder) tris.set(t, s)
  }
  return { extruder, tris }
}

/** Highest filament slot any object uses. */
export function slotsNeeded(objs: PlateObject[]): number {
  let n = 1
  for (const o of objs) if (o.slots) for (const s of o.slots) if (s > n) n = s
  return n
}

/**
 * The print settings as a project config. Slicers read the keys they know and keep their own defaults for the rest. The
 * filament lists must all be as long as the number of filaments used, and the purge-volume tables are `n x n` and `2n`.
 */
export function projectConfig(s: PrintSettings, filaments: number): Record<string, unknown> {
  const n = Math.max(filaments, 1)
  const per = (v: string) => Array.from({ length: n }, () => v)
  return {
    ...Object.fromEntries(Object.entries(FILAMENT_DEFAULTS).map(([k, v]) => [k, per(v)])),
    from: 'project',
    print_settings_id: '',
    printer_settings_id: '',
    filament_settings_id: per(''),
    nozzle_diameter: [String(s.nozzle)],
    printable_height: '256',
    printable_area: ['0x0', `${s.printer.bed[0]}x0`, `${s.printer.bed[0]}x${s.printer.bed[1]}`, `0x${s.printer.bed[1]}`],
    layer_height: String(s.layerHeight),
    initial_layer_print_height: String(s.firstLayerHeight),
    wall_loops: String(s.wallLoops),
    top_shell_layers: String(s.topLayers),
    bottom_shell_layers: String(s.bottomLayers),
    sparse_infill_density: `${s.infill}%`,
    sparse_infill_pattern: s.infillPattern,
    enable_support: s.support === 'none' ? '0' : '1',
    support_type: s.support === 'tree' ? 'tree(auto)' : 'normal(auto)',
    support_threshold_angle: String(Math.round(90 - s.overhang)),
    brim_type: s.brim === 'none' ? 'no_brim' : s.brim === 'outer' ? 'outer_only' : 'auto_brim',
    filament_type: per('PLA'),
    filament_ids: per(''),
    different_settings_to_system: Array.from({ length: n + 2 }, () => ''),
    inherits_group: Array.from({ length: n + 2 }, () => ''),
    filament_colour: Array.from({ length: n }, (_, i) => colorById(s.slotColors[i] ?? 'white').hex.toUpperCase()),
    filament_map: per('1'),
    filament_self_index: Array.from({ length: n }, (_, i) => String(i + 1)),
    flush_volumes_matrix: Array.from({ length: n * n }, (_, i) => (Math.floor(i / n) === i % n ? '0' : '280')),
    flush_volumes_vector: Array.from({ length: 2 * n }, () => '140'),
  }
}

const IDENT = '1 0 0 0 1 0 0 0 1'
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n'
const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"'
/** Production-extension ids look like UUIDs; these are made up from the object number so a file is reproducible. */
const uuid = (a: number, tail: string) => `${a.toString(16).padStart(8, '0')}-${tail}`

/**
 * Write the 3MF in the layout Bambu Studio and OrcaSlicer write themselves: every body is an object whose mesh lives in
 * `3D/Objects/object_N.model`, with the per-object name, filament and settings in `Metadata/model_settings.config`.
 * `placements[i]` is where object i sits on the plate (translation of its build item).
 */
export function writeBambu3mf(objects: PlateObject[], placements: Placement[], settings: PrintSettings, app = 'BambuStudio-01.10.00.00'): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const assemblies: string[] = []
  const parts: string[] = []
  const plate: string[] = []
  const build: string[] = []
  const rels: string[] = []
  objects.forEach((o, i) => {
    const meshId = 2 * i + 1, asmId = 2 * i + 2
    const path = `/3D/Objects/object_${i + 1}.model`
    const tris = o.indices.length / 3
    const sl = objectSlots(o.slots, tris)
    const v: string[] = []
    for (let k = 0; k < o.positions.length; k += 3) v.push(`<vertex x="${num(o.positions[k])}" y="${num(o.positions[k + 1])}" z="${num(o.positions[k + 2])}"/>`)
    const t: string[] = []
    for (let k = 0; k < tris; k++) {
      const paint = sl.tris.get(k)
      t.push(`<triangle v1="${o.indices[k * 3]}" v2="${o.indices[k * 3 + 1]}" v3="${o.indices[k * 3 + 2]}"${paint ? ` paint_color="${paintColorCode(paint)}"` : ''}/>`)
    }
    files[path.slice(1)] = strToU8(
      `${XML}<model unit="millimeter" xml:lang="en-US" ${NS}>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n  <object id="${meshId}" p:UUID="${uuid(meshId, '81cb-4c03-9d28-80fed5dfa1dc')}" type="model">\n   <mesh>\n    <vertices>\n${v.join('\n')}\n    </vertices>\n    <triangles>\n${t.join('\n')}\n    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build/>\n</model>\n`,
    )
    rels.push(` <Relationship Target="${path}" Id="rel-${i + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`)
    assemblies.push(
      `  <object id="${asmId}" p:UUID="${uuid(asmId, '61cb-4c03-9d28-80fed5dfa1dc')}" type="model">\n   <components>\n    <component p:path="${path}" objectid="${meshId}" p:UUID="${uuid(meshId * 65536, 'b206-40ff-9872-83e8017abed1')}" transform="${IDENT} 0 0 0"/>\n   </components>\n  </object>`,
    )
    const off = placements[i]?.offset ?? [0, 0, 0]
    build.push(`  <item objectid="${asmId}" p:UUID="${uuid(asmId, 'b1ec-4553-aec9-835e5b724bb4')}" transform="${IDENT} ${num(off[0])} ${num(off[1])} ${num(off[2])}" printable="1"/>`)
    parts.push(
      `  <object id="${asmId}">\n    <metadata key="name" value="${esc(o.name)}"/>\n    <metadata key="extruder" value="${sl.extruder}"/>\n` +
      `    <part id="${meshId}" subtype="normal_part">\n      <metadata key="name" value="${esc(o.name)}"/>\n      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n` +
      `      <metadata key="extruder" value="${sl.extruder}"/>\n      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n    </part>\n  </object>`,
    )
    plate.push(`    <model_instance>\n      <metadata key="object_id" value="${asmId}"/>\n      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="${100 + i}"/>\n    </model_instance>`)
  })
  const model =
    `${XML}<model unit="millimeter" xml:lang="en-US" ${NS}>\n <metadata name="Application">${esc(app)}</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n` +
    ` <resources>\n${assemblies.join('\n')}\n </resources>\n <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">\n${build.join('\n')}\n </build>\n</model>\n`
  const modelSettings =
    `${XML}<config>\n${parts.join('\n')}\n  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n${plate.join('\n')}\n  </plate>\n  <assemble>\n  </assemble>\n</config>\n`
  const sliceInfo = `${XML}<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value=""/>\n  </header>\n</config>\n`
  return zipSync({
    '[Content_Types].xml': strToU8(
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="png" ContentType="image/png"/>\n</Types>\n`,
    ),
    '_rels/.rels': strToU8(
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n`,
    ),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/project_settings.config': strToU8(JSON.stringify(projectConfig(settings, slotsNeeded(objects)), null, 2)),
    '3D/_rels/3dmodel.model.rels': strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n${rels.join('\n')}\n</Relationships>\n`),
    ...files,
    'Metadata/model_settings.config': strToU8(modelSettings),
    'Metadata/slice_info.config': strToU8(sliceInfo),
  }, { level: 6 })
}

export interface Footprint { w: number; d: number }

/**
 * Lay footprints out in rows on the plate (largest first, `gap` mm apart) and centre the layout on the plate.
 * Returns the centre each footprint should sit at, and whether everything fits.
 */
export function arrangeOnPlate(items: Footprint[], plate: [number, number], gap = 6): { centres: [number, number][]; fits: boolean } {
  const order = items.map((_, i) => i).sort((a, b) => items[b].d - items[a].d || items[b].w - items[a].w)
  const rows: { y: number; h: number; x: number; ids: number[] }[] = []
  const pos: [number, number][] = items.map(() => [0, 0])
  const maxW = Math.max(plate[0] - 2 * gap, 1)
  let y = 0
  for (const i of order) {
    let row = rows.find((r) => r.x + items[i].w <= maxW && items[i].d <= r.h + 1e-6)
    if (!row) {
      row = { y, h: items[i].d, x: 0, ids: [] }
      rows.push(row)
      y += items[i].d + gap
    }
    pos[i] = [row.x + items[i].w / 2, row.y + items[i].d / 2]
    row.x += items[i].w + gap
    row.ids.push(i)
  }
  const totalW = Math.max(...rows.map((r) => r.x - gap), 0)
  const totalD = y - gap
  const ox = plate[0] / 2 - totalW / 2, oy = plate[1] / 2 - totalD / 2
  // centre each row on its own width
  const centres = pos.map((p) => [p[0] + ox, p[1] + oy] as [number, number])
  for (const r of rows) {
    const rowW = r.x - gap
    const shift = (totalW - rowW) / 2
    for (const i of r.ids) centres[i][0] += shift
  }
  return { centres, fits: totalW <= plate[0] && totalD <= plate[1] }
}
