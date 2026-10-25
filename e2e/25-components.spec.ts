import { test, expect } from './helpers'
import type { App } from './helpers'

/** A box feature added without the UI (deterministic geometry). */
async function addBox(app: App, name: string, size: [number, number, number], position: [number, number, number] = [0, 0, 0]) {
  const id = await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a.size[0], depth: a.size[1], height: a.size[2], position: a.position }, a.name), { name, size, position })
  await app.idle()
  return id as string
}

/** The component of every feature (undefined: the root). */
const featureComponents = (app: App) => app.ev((c) => c.doc.getState().features.map((f: { component?: string }) => f.component ?? null)) as Promise<(string | null)[]>

test('components: new component, activate, the browser tree and the timeline sections', async ({ app, page }) => {
  await app.open()
  await addBox(app, 'Loose', [10, 10, 10], [60, 0, 0])

  // New Component from the Assemble tab: it becomes active and the next feature goes into it
  await app.tab('Assemble')
  await app.ribbon('New Component').click()
  const tree = page.locator('.panel', { has: page.getByTestId('components-group') })
  await expect(page.getByTestId('comp-o1')).toBeVisible()
  await expect(page.getByTestId('comp-o1')).toHaveAttribute('data-active', 'true')
  await addBox(app, 'Plate', [40, 40, 4])
  expect(await featureComponents(app)).toEqual([null, 'c1'])
  await expect(page.getByTestId('tl-sec-root')).toBeVisible()
  await expect(page.getByTestId('tl-sec-c1')).toBeVisible()
  await expect(page.getByTestId('tl-sec-c1')).toHaveAttribute('data-active', 'true')
  // the plate is listed under its component, not under the root
  await expect(tree.locator('.tree-row', { hasText: 'Plate' })).toHaveCount(1)
  await app.shot('components-active')

  // rename from the context menu
  await page.getByTestId('comp-o1').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Rename/ }).click()
  await page.locator('.tree-row input.rename').fill('Base plate')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('comp-o1')).toContainText('Base plate')
  await expect(page.getByTestId('tl-sec-c1').locator('.tl-sec-label')).toHaveText('Base plate')

  // leaving the component: new features go back to the root
  await page.getByTestId('comp-o1').getByRole('button', { name: 'Deactivate component' }).click()
  await expect(page.getByTestId('comp-o1')).toHaveAttribute('data-active', 'false')
  await addBox(app, 'Another', [5, 5, 5], [-60, 0, 0])
  expect(await featureComponents(app)).toEqual([null, 'c1', null])

  // hide and show the component with its eye
  await page.getByTestId('comp-o1').getByRole('button', { name: 'Hide component' }).click()
  await expect.poll(() => app.tris()).toBe(24) // two boxes of the root, 12 triangles each
  await page.getByTestId('comp-o1').getByRole('button', { name: 'Show component' }).click()
  await expect.poll(() => app.tris()).toBe(36)
})

test('components: the normal tools work inside the active component (sketch, extrude) and its origin planes activate it', async ({ app, page }) => {
  await app.open()
  await app.tab('Assemble')
  await app.ribbon('New Component').click()
  await app.ev((c) => c.assembly.actions.renameComponent('c1', 'Housing'))
  await app.tab('Solid')

  // sketch on the XY plane and extrude it as a new body, with the ordinary tools
  await app.sketchRect('XY', 30, 20, { x: 450, y: 450 })
  await app.finishSketch()
  await app.ribbon('Extrude').first().click()
  await app.field('Distance', '7')
  await app.inspector().locator('.sel').first().click()
  await page.getByRole('option', { name: 'New body' }).click()
  await app.ok()
  expect(await featureComponents(app)).toEqual(['c1', 'c1'])
  const bodies = await app.ev((c) => c.doc.getState().geometry.map((b: { id: string; component?: string }) => [b.id, b.component]))
  expect(bodies).toEqual([['f2', 'c1']])
  expect(await app.volume()).toBeCloseTo(30 * 20 * 7, 2)

  // the component lists what it holds; the sketch and the body are not in the root
  await expect(page.getByTestId('comp-o1')).toBeVisible()
  const tree = page.locator('.panel', { has: page.getByTestId('components-group') })
  await expect(tree.locator('.tree-row', { hasText: 'Sketch1' })).toHaveCount(1)
  await expect(tree.locator('.tree-row', { hasText: 'Extrude1' })).toHaveCount(1)
  // ... below the Components group, not in the root's own Bodies
  const groupY = (await page.getByTestId('components-group').boundingBox())!.y
  expect((await tree.locator('.tree-row', { hasText: 'Extrude1' }).boundingBox())!.y).toBeGreaterThan(groupY)
  expect((await tree.locator('.tree-row', { hasText: 'Sketch1' }).boundingBox())!.y).toBeGreaterThan(groupY)
  await app.shot('component-features')

  // a second component: picking one of its origin planes in the Browser makes it the active one
  await app.ev((c) => c.assembly.actions.activateOcc(null))
  await app.tab('Assemble')
  await app.ribbon('New Component').click()
  await app.ev((c) => c.assembly.actions.activateOcc(null))
  await expect(page.getByTestId('comp-o2')).toHaveAttribute('data-active', 'false')
  await page.getByTestId('comp-o2').dblclick() // double-click activates too
  await expect(page.getByTestId('comp-o2')).toHaveAttribute('data-active', 'true')
  await app.ev((c) => c.assembly.actions.activateOcc(null))
  // Origin groups: the document's own, then Housing's (o1), then the second component's (o2)
  await page.locator('.tree-row.group', { hasText: /^Origin$/ }).nth(2).click()
  await page.locator('.tree-row', { hasText: 'XZ plane' }).last().click()
  await expect(page.getByTestId('comp-o2')).toHaveAttribute('data-active', 'true')
  expect(await app.ev((c) => c.ui.getState().selection.map((r: { kind: string; id: string }) => [r.kind, r.id]))).toEqual([['plane', 'planeXZ']])
})
