import { test, expect } from './helpers'
import { addBox } from './asm'

const occurrences = (app: import('./helpers').App) => app.ev((c) => c.doc.getState().assembly.occurrences.map((o: { id: string; component: string; parent: string }) => [o.id, o.component, o.parent]))
const instanceCount = (app: import('./helpers').App) => app.ev((c) => c.assembly.place.currentInstances().length) as Promise<number>

test('instances: copy and paste a component as an instance; both share one body and follow its edits', async ({ app, page }) => {
  await app.open()
  await app.tab('Assemble')
  await app.ribbon('New Component').click()
  await app.ev((c) => c.assembly.actions.renameComponent('c1', 'Bolt'))
  const boltBox = await addBox(app, 'Shaft', [4, 4, 20])
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()

  // select the component in the Browser, copy (Ctrl+C) and paste (Ctrl+V)
  await page.getByTestId('comp-o1').click()
  await page.keyboard.press('Control+c')
  await expect(page.getByText(/Copied Bolt/)).toBeVisible()
  await page.keyboard.press('Control+v')
  await expect(page.getByTestId('comp-o2')).toBeVisible()
  expect(await occurrences(app)).toEqual([['o1', 'c1', 'root'], ['o2', 'c1', 'root']])
  // one component, one body, drawn twice
  expect(await app.ev((c) => c.doc.getState().geometry.length)).toBe(1)
  expect(await instanceCount(app)).toBe(2)
  await expect.poll(() => app.tris()).toBe(24)
  await expect(page.getByTestId('comp-o1')).toContainText('Bolt:1')
  await expect(page.getByTestId('comp-o2')).toContainText('Bolt:2')
  // the instances sit side by side, not on top of each other
  const xs = await app.ev((c) => c.assembly.place.currentInstances().map((i: { world: number[] }) => i.world[12]))
  expect(xs[1] - xs[0]).toBeGreaterThan(4)
  await app.cameraStable()
  await app.shot('instances')

  // the paste menu entry does the same
  await page.getByTestId('comp-o2').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Paste as instance' }).click()
  await expect(page.getByTestId('comp-o3')).toBeVisible()
  expect(await instanceCount(app)).toBe(3)

  // editing the component's feature changes every instance
  await app.ev((c, id) => c.doc.getState().updateFeature(id, { width: 4, depth: 4, height: 40, position: [0, 0, 0] }), boltBox)
  await app.idle()
  const heights = await app.ev((c) => c.assembly.place.currentInstances().map((i: { body: { mesh: { positions: Float32Array } }; world: number[] }) => {
    const p = i.body.mesh.positions
    let hi = -Infinity
    for (let k = 2; k < p.length; k += 3) hi = Math.max(hi, p[k] + i.world[14])
    return hi
  }))
  expect(heights).toEqual([40, 40, 40])
  expect(await app.ev((c) => c.doc.getState().geometry.length)).toBe(1)
})

test('instances: selecting by component, deleting one instance keeps the others, undo brings it back', async ({ app, page }) => {
  await app.open()
  await app.tab('Assemble')
  await app.ribbon('New Component').click()
  await addBox(app, 'Shaft', [10, 10, 10])
  await app.ev((c) => c.assembly.actions.instanceOf('o1', 30))
  await app.ev((c) => c.assembly.actions.activateOcc(null))
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()

  // the Component selection filter picks a whole instance with one click
  await page.locator('.status').getByRole('button', { name: /Select:/ }).click()
  await page.getByRole('menuitem', { name: 'component' }).click()
  const second = await app.project(30, 0, 10)
  await page.mouse.move(second.x, second.y, { steps: 3 })
  await page.mouse.click(second.x, second.y)
  await expect(page.getByTestId('comp-o2')).toHaveAttribute('data-selected', 'true')
  await expect(page.getByTestId('comp-o1')).toHaveAttribute('data-selected', 'false')

  await page.keyboard.press('Delete')
  await expect(page.getByTestId('comp-o2')).toHaveCount(0)
  expect(await instanceCount(app)).toBe(1)
  expect(await app.ev((c) => c.doc.getState().features.length)).toBe(1) // the component is still used by the other instance
  await app.ev((c) => c.doc.getState().undo())
  await expect(page.getByTestId('comp-o2')).toBeVisible()
  expect(await instanceCount(app)).toBe(2)
})

test('instances: nested components, isolate and hide act on the instance', async ({ app, page }) => {
  await app.open()
  await app.tab('Assemble')
  await app.ribbon('New Component').click() // Component1
  await addBox(app, 'Base', [30, 30, 4])
  await app.ribbon('New Component').click() // Component2, inside Component1
  await addBox(app, 'Post', [4, 4, 12], [0, 0, 4])
  await app.ev((c) => c.assembly.actions.activateOcc(null))
  await addBox(app, 'Loose', [6, 6, 6], [50, 0, 0])
  expect(await occurrences(app)).toEqual([['o1', 'c1', 'root'], ['o2', 'c2', 'c1']])
  // the inner component is listed under the outer one, further in
  const outer = await page.getByTestId('comp-o1').boundingBox()
  const inner = await page.getByTestId('comp-o1/o2').boundingBox()
  expect(inner!.y).toBeGreaterThan(outer!.y)
  const pad = (id: string) => page.getByTestId(id).evaluate((e) => parseInt((e as HTMLElement).style.paddingLeft))
  expect(await pad('comp-o1/o2')).toBeGreaterThan(await pad('comp-o1'))

  // hiding the outer component hides what is inside it; the loose body stays
  await page.getByTestId('comp-o1').getByRole('button', { name: 'Hide component' }).click()
  await expect.poll(() => app.tris()).toBe(12)
  await page.getByTestId('comp-o1').getByRole('button', { name: 'Show component' }).click()
  await expect.poll(() => app.tris()).toBe(36)
  // isolate: only the inner component (and what it sits in) stays
  await page.getByTestId('comp-o1/o2').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Isolate' }).click()
  await expect.poll(() => app.tris()).toBe(24)
  await page.getByTestId('comp-o1/o2').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Show all' }).click()
  await expect.poll(() => app.tris()).toBe(36)
  await app.shot('nested-components')
})
