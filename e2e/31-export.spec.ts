import fs from 'node:fs'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { test, expect } from './helpers'
import type { App } from './helpers'
import { addBox, addJoint } from './asm'

/** A grounded plate and a bar component placed twice by revolute joints: one turned 90 degrees (runs along Y), one not. */
async function scene(app: App) {
  await addBox(app, 'Plate', [40, 40, 4])
  await addBox(app, 'Bar', [30, 6, 6], [200, 0, 0])
  const ids = await app.ev((c) => c.doc.getState().geometry.map((b: { id: string }) => b.id))
  await app.ev((c, ids) => c.assembly.actions.componentsFromBodies(ids), ids) // o1 plate, o2 bar
  await app.ev((c) => c.assembly.actions.instanceOf('o2', 0)) // o3, the second bar
  await app.ev((c) => c.assembly.actions.setGrounded('o1', true))
  // the bar's own origin is the middle of its underside (def space x = 200)
  await addJoint(app, { name: 'Hinge 1', type: 'revolute', a: 'o1', b: 'o2', fa: [-12, 0, 4], fb: [200, 0, 0], extra: { values: { angle: 90 } } })
  await addJoint(app, { name: 'Hinge 2', type: 'revolute', a: 'o1', b: 'o3', fa: [12, 0, 4], fb: [200, 0, 0] })
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
}

async function exportAs(app: App, page: import('@playwright/test').Page, format: 'STEP' | '3MF' | 'STL', dir: string) {
  await app.ev((c) => c.runCommand('file.export'))
  await page.getByRole('radio', { name: format, exact: true }).click()
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.inspector-foot').getByRole('button', { name: 'OK' }).click()])
  const file = path.join(dir, dl.suggestedFilename())
  await dl.saveAs(file)
  return { file, name: dl.suggestedFilename(), bytes: fs.readFileSync(file) }
}

const extent = (vals: number[][]) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const v of vals) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]) }
  return { lo: lo.map((x) => +x.toFixed(3)), hi: hi.map((x) => +x.toFixed(3)) }
}
/** Objects of a plain 3MF: name -> vertex extent. */
function objects3mf(bytes: Buffer) {
  const model = strFromU8(unzipSync(new Uint8Array(bytes))['3D/3dmodel.model'])
  const out: Record<string, { lo: number[]; hi: number[] }> = {}
  for (const m of model.matchAll(/<object id="\d+" type="model" name="([^"]+)"><mesh><vertices>(.*?)<\/vertices>/g)) {
    out[m[1]] = extent([...m[2].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map((v) => [+v[1], +v[2], +v[3]]))
  }
  return { out, items: (model.match(/<item /g) ?? []).length }
}

test('export: STEP carries the component structure and the placed positions', async ({ app, page }, info) => {
  await app.open()
  await scene(app)
  const dir = path.dirname(info.outputPath('x'))
  const { bytes, name } = await exportAs(app, page, 'STEP', dir)
  expect(name).toBe('Untitled.step')
  const text = bytes.toString('latin1')
  for (const n of ["'Untitled'", "'Plate'", "'Bar:1'", "'Bar:2'", "'Bar'"]) expect(text, n).toContain(n)
  // two placed bars and the plate under the root, sharing one solid for the bars
  expect((text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE/g) ?? []).length).toBe(3)
  expect((text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length).toBe(2)

  // read back into a new document: the assembly sits where it was
  await app.ev(async (c) => { c.doc.getState().newDocument(); await c.regenerate() })
  const box = await app.ev(async (c, arr) => {
    await c.importFiles([new File([Uint8Array.from(arr)], 'back.step')])
    const p = c.doc.getState().geometry[0].mesh.positions
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let k = 0; k < p.length; k += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[k + a]); hi[a] = Math.max(hi[a], p[k + a]) }
    return { lo: lo.map((v: number) => Math.round(v)), hi: hi.map((v: number) => Math.round(v)) }
  }, Array.from(bytes))
  expect(box).toEqual({ lo: [-20, -20, 0], hi: [27, 20, 10] })
})

test('export: 3MF has one object per component instance, each at its current position', async ({ app, page }, info) => {
  await app.open()
  await scene(app)
  const dir = path.dirname(info.outputPath('x'))
  const { bytes, name } = await exportAs(app, page, '3MF', dir)
  expect(name).toBe('Untitled.3mf')
  const { out, items } = objects3mf(bytes)
  expect(items).toBe(3)
  expect(Object.keys(out).sort()).toEqual(['Bar:1', 'Bar:2', 'Plate'])
  expect(out.Plate).toEqual({ lo: [-20, -20, 0], hi: [20, 20, 4] })
  // the first bar is turned 90 degrees about its hinge at x = -12: it runs along Y
  expect(out['Bar:1']).toEqual({ lo: [-15, -15, 4], hi: [-9, 15, 10] })
  // the second keeps its direction, hinged at x = 12
  expect(out['Bar:2']).toEqual({ lo: [-3, -3, 4], hi: [27, 3, 10] })

  // moving a joint moves the exported object
  await app.ev((c) => c.assembly.actions.setJointValues({ j2: { angle: 90 } }))
  const again = objects3mf((await exportAs(app, page, '3MF', dir)).bytes)
  expect(again.out['Bar:2']).toEqual({ lo: [9, -15, 4], hi: [15, 15, 10] })
})

test('export: the print plate takes the same instances, and a selection exports only what is selected', async ({ app, page }, info) => {
  await app.open()
  await scene(app)
  const dir = path.dirname(info.outputPath('x'))
  await app.tab('Print')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export 3MF' }).click()])
  const file = path.join(dir, 'plate.3mf')
  await dl.saveAs(file)
  const files = unzipSync(new Uint8Array(fs.readFileSync(file)))
  const settings = strFromU8(files['Metadata/model_settings.config'])
  expect((settings.match(/<model_instance>/g) ?? []).length).toBe(3)
  for (const n of ['Plate', 'Bar:1', 'Bar:2']) expect(settings).toContain(`<metadata key="name" value="${n}"/>`)
  // each object's mesh is the placed one (the first bar is long in Y)
  const bar1 = strFromU8(files['3D/Objects/object_2.model'])
  const ys = [...bar1.matchAll(/<vertex x="[^"]+" y="([^"]+)"/g)].map((m) => +m[1])
  expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(30, 3)
  await expect(page.getByText(/Exported Untitled\.3mf \(3 bodies/)).toBeVisible()

  // File > Export with a selection: only the selected component instance
  await page.getByTestId('comp-o2').click()
  await app.ev((c) => c.runCommand('file.export'))
  await page.getByRole('radio', { name: '3MF', exact: true }).click()
  await page.getByRole('radio', { name: 'Selection' }).click()
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('.inspector-foot').getByRole('button', { name: 'OK' }).click()])
  const sel = path.join(dir, 'sel.3mf')
  await dl2.saveAs(sel)
  expect(Object.keys(objects3mf(fs.readFileSync(sel)).out)).toEqual(['Bar:1'])
})
