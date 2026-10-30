/**
 * The parts list of a drawing, built from the component tree: real features, the real regeneration engine and real OpenCascade.
 * Grouping, quantities, material / description, following edits, balloons, and surviving save / open and the three exports.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/kernel/client', async () => {
  const { api } = await import('@/kernel/api')
  return { getKernel: () => api as never }
})

import { PDFDocument } from 'pdf-lib'
import { initOcc } from '@/kernel/occ'
import { clearCache, regenerate } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import { loadProject, serializeProject } from '@/io/project'
import '@/features/basic'
import { activateOcc, deleteOccurrence, instanceOf, newComponent, renameComponent, setComponentInfo } from '@/assembly/actions'
import { useAssemblyRuntime } from '@/assembly/runtime'
import { itemExists, itemMatrix, itemsFor, listComponents } from './components'
import { sheetToDxf } from './export/dxf'
import { sheetsToPdf } from './export/pdf'
import { sheetToSvg } from './export/svg'
import { sheetDims } from './sheets'
import { buildSheet } from './sheetprims'
import { drawingActions, useDrawing, activeSheet } from './store'
import { useViewGeoms } from './views'

beforeAll(async () => { await initOcc() })
beforeEach(async () => {
  clearCache()
  useAssemblyRuntime.setState({ drive: {} })
  useDoc.getState().newDocument()
  useDrawing.getState().load(null)
  useViewGeoms.setState({ geoms: {}, pending: {}, errors: {} })
  await regenerate()
})

const doc = () => useDoc.getState()
async function addBox(w: number, d: number, h: number, name?: string) {
  doc().addFeature('box', { width: w, depth: d, height: h, position: [0, 0, 0] } as never, name)
  await regenerate()
}
/** A component holding one box. Leaves the root active. */
async function part(name: string, w: number, d: number, h: number) {
  const c = newComponent(name)
  await addBox(w, d, h, name)
  activateOcc(null)
  return c
}

const rows = () => listComponents().map((c) => ({ name: c.name, qty: c.qty, material: c.material, description: c.description }))
const output = () => buildSheet({ doc: useDrawing.getState().doc, sheet: activeSheet()!, bodies: doc().geometry, geoms: {}, parts: listComponents() })
const texts = () => output().prims.filter((p) => p.k === 'text').map((p) => (p as { text: string }).text)

describe('parts list of an assembly', () => {
  it('has one row per component with the number of instances as the quantity', async () => {
    const plate = await part('Plate', 40, 40, 4)
    await part('Bolt', 4, 4, 20)
    const bolt = doc().assembly.occurrences[1]
    instanceOf(bolt.id, 10)
    instanceOf(bolt.id, 20)
    expect(rows()).toEqual([
      { name: 'Plate', qty: 1, material: '', description: '' },
      { name: 'Bolt', qty: 3, material: '', description: '' },
    ])
    expect(plate.def).toBeTruthy()
  })

  it('counts a part inside a sub-assembly once per copy of the sub-assembly', async () => {
    const sub = newComponent('Bracket')
    // a nested component inside the active Bracket
    newComponent('Screw')
    await addBox(3, 3, 12, 'Screw')
    activateOcc(null)
    instanceOf(sub.occ, 50) // second Bracket
    expect(rows()).toEqual([{ name: 'Screw', qty: 2, material: '', description: '' }])
  })

  it('merges different components that are the same part, and keeps differently sized ones apart', async () => {
    await part('Spacer', 10, 10, 5)
    await part('Spacer', 10, 10, 5)
    await part('Spacer', 10, 10, 8)
    expect(rows().map((r) => [r.name, r.qty])).toEqual([['Spacer', 2], ['Spacer', 1]])
  })

  it('shows the material and description of the component', async () => {
    const plate = await part('Plate', 40, 40, 4)
    setComponentInfo(plate.def, { material: 'Aluminium 6061', description: 'Base plate' })
    expect(rows()[0]).toMatchObject({ material: 'Aluminium 6061', description: 'Base plate' })
    drawingActions.ensureSheet()
    drawingActions.addNote(activeSheet()!.id, { kind: 'partsList', pos: [20, 20] })
    const t = texts()
    for (const s of ['ITEM', 'QTY', 'PART NAME', 'MATERIAL', 'DESCRIPTION', 'Plate', 'Aluminium 6061', 'Base plate']) expect(t).toContain(s)
    // clearing a field removes it again
    setComponentInfo(plate.def, { material: '' })
    expect(rows()[0].material).toBe('')
    expect(rows()[0].description).toBe('Base plate')
  })

  it('follows the assembly: adding an instance, removing one, renaming and removing a component', async () => {
    drawingActions.ensureSheet()
    const sid = activeSheet()!.id
    drawingActions.addNote(sid, { kind: 'partsList', pos: [20, 20] })
    await part('Plate', 40, 40, 4)
    const bolt = await part('Bolt', 4, 4, 20)
    expect(texts()).toContain('Bolt')
    const second = instanceOf(bolt.occ, 10)!
    expect(rows().find((r) => r.name === 'Bolt')!.qty).toBe(2)
    expect(texts()).toContain('2')
    deleteOccurrence(second)
    expect(rows().find((r) => r.name === 'Bolt')!.qty).toBe(1)
    renameComponent(bolt.def, 'Cap screw')
    expect(texts()).toContain('Cap screw')
    expect(texts()).not.toContain('Bolt')
    deleteOccurrence(bolt.occ)
    expect(rows().map((r) => r.name)).toEqual(['Plate'])
    expect(texts()).not.toContain('Cap screw')
  })

  it('balloons use the item number of their component, which survives edits of other rows', async () => {
    const plate = await part('Plate', 40, 40, 4)
    const bolt = await part('Bolt', 4, 4, 20)
    drawingActions.ensureSheet()
    const sid = activeSheet()!.id
    drawingActions.addNote(sid, { kind: 'balloon', pos: [80, 120], item: 'def:' + bolt.def, tip: [100, 100] })
    const balloonText = () => output().prims.filter((p) => p.k === 'text' && p.owner?.startsWith('note:')).map((p) => (p as { text: string }).text)
    expect(balloonText()).toEqual(['2'])
    deleteOccurrence(plate.occ)
    expect(balloonText()).toEqual(['1'])
  })

  it('places instances: items carry their occurrence and its pose, gone instances do not exist', async () => {
    const bolt = await part('Bolt', 4, 4, 20)
    const second = instanceOf(bolt.occ, 25)!
    const all = itemsFor('all')
    expect(all.map((i) => i.occ)).toEqual([bolt.occ, second])
    const m = itemMatrix(all[1])
    expect(m?.[12]).toBeCloseTo(25, 6)
    expect(itemMatrix(all[0])).toBeUndefined()
    deleteOccurrence(second)
    expect(itemExists(all[1])).toBe(false)
    expect(itemExists(all[0])).toBe(true)
  })

  it('plain parts without components keep working: equal bodies are one row', async () => {
    await addBox(20, 20, 5, 'Block')
    await addBox(20, 20, 5, 'Block')
    expect(rows()).toEqual([{ name: 'Block', qty: 2, material: '', description: '' }])
  })
})

describe('saving and exporting', () => {
  it('the parts list survives save and open, and is in the PDF, SVG and DXF', async () => {
    const plate = await part('Plate', 40, 40, 4)
    const bolt = await part('Bolt', 4, 4, 20)
    instanceOf(bolt.occ, 10)
    setComponentInfo(plate.def, { material: 'Steel S235', description: 'Base' })
    drawingActions.ensureSheet()
    const sid = activeSheet()!.id
    drawingActions.addNote(sid, { kind: 'partsList', pos: [20, 20] })
    drawingActions.addNote(sid, { kind: 'balloon', pos: [80, 120], item: 'def:' + bolt.def, tip: [100, 100] })
    const before = rows()

    const bytes = await serializeProject(false)
    useDoc.getState().newDocument()
    useDrawing.getState().load(null)
    await regenerate()
    expect(listComponents()).toEqual([])
    loadProject(bytes)
    await regenerate()

    expect(rows()).toEqual(before)
    expect(rows().find((r) => r.name === 'Bolt')!.qty).toBe(2)
    const sheet = activeSheet()!
    expect(sheet.notes.map((n) => n.kind)).toEqual(['partsList', 'balloon'])
    const t = texts()
    for (const s of ['Plate', 'Bolt', 'Steel S235', 'Base']) expect(t).toContain(s)
    // the balloon still points at Bolt (item 2)
    expect(output().prims.filter((p) => p.k === 'text' && p.owner === 'note:' + sheet.notes[1].id).map((p) => (p as { text: string }).text)).toEqual(['2'])

    const { prims } = output()
    const { w, h } = sheetDims(sheet)
    const svg = sheetToSvg(prims, w, h, 'test')
    expect(svg).toContain('Steel S235')
    expect(svg).toContain('PART NAME')
    const dxf = sheetToDxf(prims, w, h)
    expect(dxf).toContain('Steel S235')
    expect(dxf).toContain('Bolt')
    const pdf = await sheetsToPdf([{ prims, w, h, title: sheet.name }], 'test')
    const parsed = await PDFDocument.load(pdf)
    expect(parsed.getPageCount()).toBe(1)
    expect(pdf.length).toBeGreaterThan(1000)
  })
})
