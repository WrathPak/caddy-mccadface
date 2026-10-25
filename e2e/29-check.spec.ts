import { test, expect } from './helpers'
import { addBox, addJoint, plateAndBar } from './asm'

/** Three components: a block, one that overlaps it over 4 mm of its width, and one 3 mm clear of it on the other side. */
async function blocks(app: import('./helpers').App) {
  await addBox(app, 'Block A', [20, 20, 10])
  await addBox(app, 'Block B', [20, 20, 10], [16, 0, 0]) // overlaps A over x = 6..10 (4 deep)
  await addBox(app, 'Block C', [20, 20, 10], [-23, 0, 0]) // spans -33..-13: 3 mm clear of A (-10..10)
  const ids = await app.ev((c) => c.doc.getState().geometry.map((b: { id: string }) => b.id))
  await app.ev((c, ids) => c.assembly.actions.componentsFromBodies(ids), ids)
  await app.idle()
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
}

test('interference: finds overlapping parts, lists them, draws the overlap in red and goes stale when the model moves', async ({ app, page }) => {
  await app.open()
  await blocks(app)
  await app.tab('Assemble')
  await app.ribbon('Interference').click()
  await expect(page.getByTestId('interference-result')).toBeVisible()
  await expect(page.getByTestId('interference-result')).toHaveAttribute('data-count', '1')
  await expect(page.getByTestId('interference-hit-0')).toContainText('Block A')
  await expect(page.getByTestId('interference-hit-0')).toContainText('Block B')
  await expect(page.getByTestId('interference-hit-0')).toContainText('800 mm')
  const hit = await app.ev((c) => { const h = c.assembly.rt.getState().interference.hits[0]; return { v: h.volume, min: h.min, max: h.max } })
  expect(hit.v).toBeCloseTo(4 * 20 * 10, 3) // 4 deep, 20 wide, 10 high: 800
  expect(hit.min[0]).toBeCloseTo(6, 3)
  expect(hit.max[0]).toBeCloseTo(10, 3)
  // the overlap is in the scene, and the two parts are tinted
  expect(await app.ev((c) => c.three.scene.getObjectByName('check-overlays').children.length)).toBe(1)
  await app.shot('interference')

  // clicking the result frames the overlap
  const before = await app.ev((c) => JSON.stringify(c.three.camera.matrixWorld.elements))
  await page.getByTestId('interference-hit-0').click()
  await app.cameraStable()
  expect(await app.ev((c) => JSON.stringify(c.three.camera.matrixWorld.elements))).not.toBe(before)

  // the third block touches nothing; moving B away makes the result out of date
  await app.ev((c) => c.assembly.actions.moveOccurrence('o2', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1]))
  await expect(page.getByTestId('interference-result')).toHaveAttribute('data-stale', 'true')
  await expect(page.getByTestId('interference-result')).toContainText('out of date')
  await page.getByTestId('interference-run').click()
  await expect(page.getByTestId('interference-result')).toContainText('No interference found')
  await expect(page.getByTestId('interference-result')).toHaveAttribute('data-count', '0')
})

test('interference: checking one component against the rest, and joints put parts into overlap', async ({ app, page }) => {
  await app.open()
  await plateAndBar(app) // plate and bar do not touch
  await app.tab('Assemble')
  await app.ribbon('Drive Joints').click()
  await app.ev((c) => c.assembly.actions.setGrounded('o1', true))
  // the bar's underside is at the joint origin (the plate's top face); a slider pushes it down into the plate
  const id = await addJoint(app, { name: 'Slide', type: 'slider', a: 'o1', b: 'o2', fa: [0, 0, 4], fb: [45, 0, 0] })
  await app.ev((c, id) => c.assembly.actions.setJointValues({ [id]: { distance: -3 } }), id)
  await page.getByTestId('comp-o2').click()
  await page.getByTestId('asm-tab-check').click()
  await page.getByTestId('interference-run').click()
  // the bar is 3 mm inside the plate: 30 x 6 x 3
  await expect(page.getByTestId('interference-result')).toHaveAttribute('data-count', '1')
  const v = await app.ev((c) => c.assembly.rt.getState().interference.hits[0].volume)
  expect(v).toBeCloseTo(30 * 6 * 3, 3)
  // back to resting on the plate: touching faces are not an overlap
  await app.ev((c, id) => c.assembly.actions.setJointValues({ [id]: { distance: 0 } }), id)
  await page.getByTestId('interference-run').click()
  await expect(page.getByTestId('interference-result')).toHaveAttribute('data-count', '0')
})

test('clearance: the smallest gap between two components, with the closest points drawn', async ({ app, page }) => {
  await app.open()
  await blocks(app)
  await app.tab('Assemble')
  await app.ribbon('Clearance').click()
  // nothing selected: a hint rather than a wrong answer
  await page.getByTestId('clearance-run').click()
  await expect(page.getByText(/Select exactly two components/)).toBeVisible()
  await page.getByTestId('comp-o1').click()
  await page.getByTestId('comp-o3').click({ modifiers: ['Control'] })
  await page.getByTestId('clearance-run').click()
  const res = page.getByTestId('clearance-result')
  await expect(res).toContainText('3 mm apart')
  expect(Number(await res.getAttribute('data-distance'))).toBeCloseTo(3, 2)
  await expect(page.getByTestId('clearance-label')).toHaveText('3 mm')
  await app.shot('clearance')
  // touching parts report 0, overlapping too
  await page.getByTestId('comp-o1').click()
  await page.getByTestId('comp-o2').click({ modifiers: ['Control'] })
  await page.getByTestId('clearance-run').click()
  await expect(res).toContainText('touching or overlapping')
})
