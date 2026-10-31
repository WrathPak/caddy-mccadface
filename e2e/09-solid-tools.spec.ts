import { test, expect, addSketch, XY, XZ, type App } from './helpers'
import type { Page } from '@playwright/test'
import { writeCylinderFixture } from './fixtures'

const okButton = (page: Page) => page.locator('.inspector-foot').getByRole('button', { name: 'OK' })
const hint = (page: Page) => page.getByTestId('inspector-hint')
const treeRow = (page: Page, name: string) => page.locator('.tree-row', { hasText: name }).first()

async function addBox(app: App, position: [number, number, number], size = 20) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.size, depth: a.size, height: a.size, position: a.position }), { size, position })
  await app.idle()
}
async function states(app: App) {
  const f = await app.features()
  expect(f.map((x) => x.state), JSON.stringify(f.map((x) => x.error))).toEqual(f.map(() => 'ok'))
  return f
}

test('Cylinder: radius / height / plane with a live preview', async ({ app, page }) => {
  await app.open()
  await page.getByRole('button', { name: 'Box options' }).click()
  await page.getByRole('menuitem', { name: 'Cylinder' }).click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Cylinder')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  const tris0 = await app.ev((c) => c.preview.getState().items[0].mesh.indices.length / 3)
  await app.field('Radius', '6')
  await app.field('Height', '15')
  await app.inspector().getByRole('radio', { name: 'XZ' }).click()
  await expect.poll(async () => {
    const m = await app.ev((c) => {
      const p = c.preview.getState().items[0]?.mesh.positions
      if (!p) return null
      let min = Infinity, max = -Infinity
      for (let i = 1; i < p.length; i += 3) { min = Math.min(min, p[i]); max = Math.max(max, p[i]) }
      return [min, max]
    })
    return m && [Math.round(m[0]), Math.round(m[1])]
  }).toEqual([-15, 0]) // the XZ plane's normal points to -Y
  expect(tris0).toBeGreaterThan(8)
  await app.shot('cylinder-dialog')
  await app.ok()
  const f = await states(app)
  expect(f.map((x) => x.type)).toEqual(['cylinder'])
  const bb = await app.bbox()
  expect(bb.max[0] - bb.min[0]).toBeCloseTo(12, 1)
  expect(bb.min[1]).toBeCloseTo(-15, 3)
  expect(bb.max[1]).toBeCloseTo(0, 3)
  expect(await app.volume()).toBeGreaterThan(Math.PI * 36 * 15 * 0.98)
  expect(await app.volume()).toBeLessThan(Math.PI * 36 * 15 * 1.001)
})

test('Sweep: a profile along a line + arc path; OK needs the path', async ({ app, page }) => {
  await app.open()
  await addSketch(app, XY, [{ k: 'rect', x0: -2, y0: -2, x1: 2, y1: 2 }]) // Sketch1: the profile
  // Sketch2 (XZ plane): vertical line up 20, then a quarter circle curving to -X
  await addSketch(app, XZ, [{ k: 'line', a: [0, 0], b: [0, 20] }, { k: 'arc', c: [-10, 20], s: [0, 20], e: [-10, 30] }])
  await app.tab('Solid')
  await app.ribbon('Sweep').first().click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Sweep')
  // the profile was picked up automatically, the path is still missing
  await expect(okButton(page)).toBeEnabled() // profile and path were both picked up from the document
  await app.inspector().getByRole('button', { name: 'Clear' }).last().click() // clear the path
  await expect(okButton(page)).toBeDisabled()
  await expect(hint(page)).toContainText('path')
  await treeRow(page, 'Sketch2').click() // pick the path from the Browser
  await expect(okButton(page)).toBeEnabled()
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.shot('sweep-dialog')
  await app.ok()
  const f = await states(app)
  expect(f.map((x) => x.type)).toEqual(['sketch', 'sketch', 'sweep'])
  expect(await app.bodies()).toHaveLength(1)
  const len = 20 + (Math.PI / 2) * 10
  const v = await app.volume()
  expect(Math.abs(v - 16 * len) / (16 * len)).toBeLessThan(0.01)
  const bb = await app.bbox()
  expect(bb.max[2]).toBeCloseTo(32, 0) // the square's half height past the path end
  expect(bb.min[0]).toBeLessThan(-9)
  await app.shot('sweep-done')
})

test('Loft: three profiles on different planes; OK needs two', async ({ app, page }) => {
  await app.open()
  const at = (z: number) => ({ ...XY, origin: [0, 0, z] as [number, number, number] })
  await addSketch(app, XY, [{ k: 'rect', x0: -10, y0: -10, x1: 10, y1: 10 }])
  await app.tab('Solid')
  await page.getByRole('button', { name: 'Sweep options' }).click()
  await page.getByRole('menuitem', { name: 'Loft' }).click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Loft')
  await expect(okButton(page)).toBeDisabled()
  await expect(hint(page)).toContainText('profiles')
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  await addSketch(app, at(15), [{ k: 'rect', x0: -5, y0: -5, x1: 5, y1: 5 }])
  await addSketch(app, at(30), [{ k: 'rect', x0: -10, y0: -10, x1: 10, y1: 10 }])
  await page.getByRole('button', { name: 'Sweep options' }).click()
  await page.getByRole('menuitem', { name: 'Loft' }).click()
  await expect(okButton(page)).toBeEnabled() // the three profiles were picked up
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.shot('loft-dialog')
  await app.ok()
  const f = await states(app)
  expect(f.map((x) => x.type)).toEqual(['sketch', 'sketch', 'sketch', 'loft'])
  expect(await app.bodies()).toHaveLength(1)
  const bb = await app.bbox()
  expect(bb.min[2]).toBeCloseTo(0, 2)
  expect(bb.max[2]).toBeCloseTo(30, 2)
  const v = await app.volume()
  expect(v).toBeGreaterThan(30 * 100 * 0.9) // narrower than the end sections everywhere in the middle
  expect(v).toBeLessThan(30 * 400)
  await app.shot('loft-done')
})

test('Combine: join / cut / intersect with keep tools, on B-reps and meshes', async ({ app, page }) => {
  await app.open()
  await addBox(app, [0, 0, 0])
  await addBox(app, [10, 0, 0])
  await app.tab('Solid')
  await app.ribbon('Combine').first().click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Combine')
  await expect(okButton(page)).toBeDisabled()
  await expect(hint(page)).toContainText('target')
  await treeRow(page, 'Box1').click() // target
  await expect(hint(page)).toContainText('tool')
  await treeRow(page, 'Box2').click() // tool
  await expect(okButton(page)).toBeEnabled()
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.shot('combine-dialog')
  await app.ok()
  await states(app)
  expect(await app.bodies()).toHaveLength(1)
  expect(await app.volume()).toBeCloseTo(8000 + 8000 - 4000, -1)

  // cut with the tool kept
  await app.ev((c) => c.doc.getState().undo())
  await app.idle()
  expect(await app.bodies()).toHaveLength(2)
  await app.ev((c) => c.ui.getState().clearSelection())
  await app.ribbon('Combine').first().click()
  await treeRow(page, 'Box1').click()
  await treeRow(page, 'Box2').click()
  await app.inspector().getByRole('radio', { name: 'Cut' }).click()
  await app.inspector().getByRole('checkbox', { name: 'Keep tools' }).click()
  await app.ok()
  await states(app)
  const bodies = await app.bodies()
  expect(bodies).toHaveLength(2)
  expect(await app.volume(bodies[0].id)).toBeCloseTo(8000 - 4000, -1)
  expect(await app.volume(bodies[1].id)).toBeCloseTo(8000, -1)
  await app.shot('combine-cut-keep')

  // intersect, tools consumed
  await app.ev((c) => c.doc.getState().undo())
  await app.idle()
  // a body selection pre-fills the dialog: the first body is the target, the others are tools
  await app.ev((c) => c.ui.getState().setSelection(c.doc.getState().geometry.map((b: { id: string }) => ({ kind: 'body', id: b.id }))))
  await app.ev((c) => c.runCommand('solid.intersect'))
  await expect(app.inspector().getByRole('radio', { name: 'Intersect' })).toBeChecked()
  await expect(okButton(page)).toBeEnabled()
  await app.ok()
  await states(app)
  expect(await app.bodies()).toHaveLength(1)
  expect(await app.volume()).toBeCloseTo(4000, -1)

  // a mesh target (STL import) falls back to the manifold boolean
  await app.ev((c) => c.doc.getState().newDocument())
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Import').click()])
  await chooser.setFiles(writeCylinderFixture())
  await expect.poll(() => app.bodies().then((b) => b.length)).toBe(1)
  await app.idle()
  const v0 = await app.volume()
  await addBox(app, [0, 0, 10], 10) // sits on the cylinder's axis, bites into it
  await app.ribbon('Combine').first().click()
  await treeRow(page, 'cylinder').click()
  await treeRow(page, 'Box1').click()
  await app.inspector().getByRole('radio', { name: 'Cut' }).click()
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  await states(app)
  const mb = await app.bodies()
  expect(mb).toHaveLength(1)
  expect(mb[0].kind).toBe('mesh')
  const v1 = await app.volume()
  expect(v1).toBeLessThan(v0 - 500)
  expect(v1).toBeGreaterThan(v0 - 1500)
})

test('Shell: pick the top face, set thickness, hollow the box', async ({ app, page }) => {
  await app.open()
  await addBox(app, [0, 0, 0])
  await app.tab('Solid')
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.ribbon('Shell').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Shell')
  // the only body is picked for a closed hollow, so OK is ready; picking a face turns it into an open shell instead
  await expect(okButton(page)).toBeEnabled()
  expect((await app.ev((c) => c.ui.getState().inspector?.values.bodies))).toEqual(['f1'])
  const p = await app.project(0, 0, 20)
  await page.mouse.move(p.x - 30, p.y + 5)
  await page.mouse.move(p.x, p.y, { steps: 5 })
  await page.mouse.click(p.x, p.y)
  await expect(okButton(page)).toBeEnabled()
  await expect.poll(() => app.ev((c) => c.ui.getState().inspector?.values.bodies)).toEqual([])
  await app.field('Thickness', '2')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.shot('shell-dialog')
  await app.ok()
  const f = await states(app)
  expect(f.map((x) => x.type)).toEqual(['box', 'shell'])
  expect(await app.volume()).toBeCloseTo(8000 - 16 * 16 * 18, -1)
  const bb = await app.bbox()
  expect(bb.max[0] - bb.min[0]).toBeCloseTo(20, 3)
  await app.ev((c) => c.runCommand('view.home'))
  await app.shot('shell-done')
})

test('feature dialogs: OK stays disabled with a hint until the required selections are made', async ({ app, page }) => {
  await app.open()
  await addBox(app, [0, 0, 0])
  await app.tab('Solid')
  const cases: [string, RegExp][] = [
    ['Extrude', /profiles/i], ['Revolve', /profiles/i], ['Fillet', /edges/i], ['Chamfer', /edges/i],
    ['Sweep', /profile/i], ['Combine', /target/i],
  ]
  for (const [name, re] of cases) {
    await app.ribbon(name).first().click()
    await expect(app.inspector().locator('.panel-title')).toHaveText(name)
    await expect(okButton(page), name).toBeDisabled()
    await expect(hint(page), name).toContainText(re)
    // a forced click must not create anything
    await okButton(page).evaluate((b) => (b as HTMLButtonElement).click())
    await app.inspector().getByRole('button', { name: 'Cancel' }).click()
    expect((await app.features()).map((x) => x.type), name).toEqual(['box'])
  }
  await app.tab('Hair')
  for (const name of ['Hair', 'Select Faces', 'Sacrificial Wall']) {
    await app.ribbon(name).first().click()
    await expect(okButton(page), name).toBeDisabled()
    await expect(hint(page), name).toContainText(/surface/i)
    await app.inspector().getByRole('button', { name: 'Cancel' }).click()
    await app.ev((c) => c.hair.setState({ visible: true }))
  }
  expect((await app.features()).map((x) => [x.type, x.state])).toEqual([['box', 'ok']])
  await app.tab('Solid')
  // Fillet: picking an edge enables OK
  await app.ev((c) => c.ui.getState().setSelectionFilter('edge'))
  await app.ribbon('Fillet').first().click()
  await expect(okButton(page)).toBeDisabled()
  await app.ev((c) => c.ui.getState().setSelection([{ kind: 'edge', id: c.doc.getState().geometry[0].id, index: 0 }]))
  await expect(okButton(page)).toBeEnabled()
  await expect(hint(page)).toHaveCount(0)
  await app.shot('fillet-ok-enabled')
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  // a required-selection dialog opened for an empty state shows the disabled OK with its hint
  await app.ribbon('Extrude').first().click()
  await app.shot('extrude-ok-disabled')
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
})

test('Sweep and Loft honour Join / Cut / New body against an existing body', async ({ app, page }) => {
  await app.open()
  await addBox(app, [0, 0, 0]) // x, y in -10..10, z in 0..20: 8000 mm3
  await addSketch(app, XY, [{ k: 'rect', x0: -2, y0: -2, x1: 2, y1: 2 }]) // Sketch1: 4 x 4 profile at z = 0
  await addSketch(app, XZ, [{ k: 'line', a: [0, 0], b: [0, 30] }]) // Sketch2: straight path up to z = 30
  await app.tab('Solid')
  const setOperation = async (name: string) => {
    await app.inspector().locator('.sel').first().click()
    await page.getByRole('option', { name, exact: true }).click()
  }
  const sweepWith = async (op: string) => {
    await app.ribbon('Sweep').first().click()
    await expect(okButton(page)).toBeEnabled()
    await setOperation(op)
    await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
    await expect.poll(() => app.ev((c) => c.preview.getState().items[0]?.kind)).toBe(op === 'Cut' ? 'cut' : 'add')
    await app.ok()
    await states(app)
  }
  await sweepWith('Cut')
  expect(await app.bodies()).toHaveLength(1)
  expect(await app.volume()).toBeCloseTo(8000 - 16 * 20, -1) // a 4 x 4 tunnel through the 20 mm box
  await app.ev((c) => c.doc.getState().undo())
  await app.idle()
  await sweepWith('Join')
  expect(await app.bodies()).toHaveLength(1)
  expect(await app.volume()).toBeCloseTo(8000 + 16 * 10, -1) // the part of the sweep above the box is added
  await app.ev((c) => c.doc.getState().undo())
  await app.idle()
  await sweepWith('New body')
  expect(await app.bodies()).toHaveLength(2)
  await app.shot('sweep-new-body')
  await app.ev((c) => c.doc.getState().undo())
  await app.idle()

  // Loft: two 6 x 6 squares below and above the box, cut through it
  const at = (z: number) => ({ ...XY, origin: [0, 0, z] as [number, number, number] })
  await app.ev((c) => c.doc.getState().newDocument())
  await addBox(app, [0, 0, 0])
  await addSketch(app, at(-5), [{ k: 'rect', x0: -3, y0: -3, x1: 3, y1: 3 }])
  await addSketch(app, at(25), [{ k: 'rect', x0: -3, y0: -3, x1: 3, y1: 3 }])
  await page.getByRole('button', { name: 'Sweep options' }).click()
  await page.getByRole('menuitem', { name: 'Loft' }).click()
  await expect(okButton(page)).toBeEnabled()
  await setOperation('Cut')
  await expect.poll(() => app.ev((c) => c.preview.getState().items.length)).toBe(1)
  await app.ok()
  const f = await states(app)
  expect(f.map((x) => x.type)).toEqual(['box', 'sketch', 'sketch', 'loft'])
  expect(await app.bodies()).toHaveLength(1)
  expect(await app.volume()).toBeCloseTo(8000 - 36 * 20, -1)
})
