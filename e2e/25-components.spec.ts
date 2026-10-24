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
