import { test, expect } from './helpers'
import { addJoint, barId, jointsOf, plateAndBar, solved, worldBox } from './asm'

/** The plate is grounded and the bar hangs on a revolute hinge at the plate's top centre (the bar's left end). */
async function hinged(app: import('./helpers').App, extra: Record<string, unknown> = {}) {
  await plateAndBar(app)
  await app.ev((c) => c.assembly.actions.setGrounded('o1', true))
  return addJoint(app, { name: 'Hinge', type: 'revolute', a: 'o1', b: 'o2', fa: [0, 0, 4], fb: [30, 0, 0], extra })
}

test('motion: dragging a component in the viewport turns it about its joint, within the limits, as one undo step', async ({ app, page }) => {
  await app.open()
  const id = await hinged(app, { limits: { angle: { enabled: true, min: -120, max: 100, rest: 0 } } })
  await app.ev((c) => c.runCommand('view.top'))
  await app.cameraStable()
  await app.tab('Assemble')
  await app.ribbon('Move Component').click()
  const undoBefore = await app.ev((c) => c.doc.getState().undoDepth)

  // grab the bar on its top face (z = 10) 25 mm from the hinge and pull it to 25 mm along +Y
  const from = await app.project(25, 0, 10)
  const to = await app.project(0, 25, 10)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  // while the pointer is down the joint follows it (not yet part of the document)
  await expect.poll(async () => (await solved(app)).values[id].angle).toBeGreaterThan(80)
  expect((await jointsOf(app))[0].values.angle).toBe(0)
  await page.mouse.up()
  await expect.poll(async () => (await jointsOf(app))[0].values.angle).toBeGreaterThan(85)
  const angle = (await jointsOf(app))[0].values.angle
  expect(angle).toBeLessThan(95)
  expect(await app.ev((c) => c.doc.getState().undoDepth)).toBe(undoBefore + 1)
  const box = await worldBox(app, await barId(app))
  expect(box.hi[1]).toBeGreaterThan(24)
  await app.shot('drag-component')

  // beyond the limit it stops at the limit (maximum is 100 degrees)
  const far = await app.project(-60, 5, 10)
  const grab = await app.project(0, 25, 10)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(far.x, far.y, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await jointsOf(app))[0].values.angle).toBeCloseTo(100, 1)

  // undo goes back to where the first drag ended
  await app.ev((c) => c.doc.getState().undo())
  await expect.poll(async () => (await jointsOf(app))[0].values.angle).toBeCloseTo(angle, 3)
})

test('motion: grounded and rigidly held components say why they do not move; free ones move freely', async ({ app, page }) => {
  await app.open()
  await plateAndBar(app)
  await app.ev((c) => c.runCommand('view.top'))
  await app.cameraStable()
  await app.tab('Assemble')
  await app.ribbon('Move Component').click()

  // no joint: the bar moves freely (and the move is kept)
  const grab = await app.project(45, 0, 6)
  const dest = await app.project(45, 30, 6)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(dest.x, dest.y, { steps: 5 })
  await page.mouse.up()
  const moved = await worldBox(app, await barId(app))
  expect(moved.lo[1]).toBeCloseTo(27, 0)
  expect(moved.hi[1]).toBeCloseTo(33, 0)

  // grounded: a message, no movement
  await app.ev((c) => c.assembly.actions.setGrounded('o2', true))
  const g2 = await app.project(45, 30, 6)
  await page.mouse.move(g2.x, g2.y)
  await page.mouse.down()
  await page.mouse.move(g2.x + 80, g2.y, { steps: 4 })
  await page.mouse.up()
  await expect(page.getByText(/This component is grounded/)).toBeVisible()
  expect((await worldBox(app, await barId(app))).lo[1]).toBeCloseTo(moved.lo[1], 3)
})

test('motion: a motion study of keyframes plays on the nav clock and stops at its end', async ({ app, page }) => {
  await app.open()
  const id = await hinged(app)
  await app.tab('Assemble')
  await app.ribbon('Motion Study').click()
  await expect(page.getByTestId('asm-motion')).toBeVisible()

  // key 0 s at the current value (0), go to 4 s, move the joint to 90 and key again
  await page.getByTestId('motion-key').click()
  await page.getByTestId('motion-scrub').getByRole('slider').focus()
  await page.keyboard.press('End')
  await expect(page.getByTestId('motion-time')).toContainText('4.00 / 4.00')
  await app.ev((c, id) => c.assembly.actions.setJointValues({ [id]: { angle: 90 } }), id)
  await page.getByTestId('motion-key').click()
  const track = await app.ev((c) => c.doc.getState().assembly.motion.tracks)
  expect(track).toHaveLength(1)
  expect(track[0].frames.map((f: { t: number; v: number }) => [f.t, f.v])).toEqual([[0, 0], [4, 90]])
  await app.shot('motion-study')

  // play it on a frozen clock: halfway through, the angle is halfway
  await app.ev((c) => c.nav.freeze())
  await page.getByTestId('motion-stop').click()
  await page.getByTestId('motion-play').click()
  await app.ev((c) => c.nav.tick(2000))
  await app.ev((c) => c.assembly.motion.tickAnimations())
  await expect.poll(async () => (await solved(app)).values[id].angle).toBeCloseTo(45, 3)
  const half = await worldBox(app, await barId(app))
  expect(half.hi[1]).toBeCloseTo(30 * Math.sin(Math.PI / 4) + 3 * Math.cos(Math.PI / 4), 2)
  await expect(page.getByTestId('motion-time')).toContainText('2.00 / 4.00')
  // the document itself did not change while playing
  expect((await jointsOf(app))[0].values.angle).toBe(90)

  // pause keeps the pose, play carries on from there
  await page.getByTestId('motion-pause').click()
  await app.ev((c) => c.nav.tick(1500))
  await app.ev((c) => c.assembly.motion.tickAnimations())
  await expect(page.getByTestId('motion-time')).toContainText('2.00 / 4.00')
  await page.getByTestId('motion-play').click()
  await app.ev((c) => c.nav.tick(1000))
  await app.ev((c) => c.assembly.motion.tickAnimations())
  await expect.poll(async () => (await solved(app)).values[id].angle).toBeCloseTo(67.5, 3)

  // past the end it stops on the last keyframe
  await app.ev((c) => c.nav.tick(5000))
  await app.ev((c) => c.assembly.motion.tickAnimations())
  await expect(page.getByTestId('motion-play')).toBeVisible()
  await expect.poll(async () => (await solved(app)).values[id].angle).toBeCloseTo(90, 3)
  await app.ev((c) => c.nav.unfreeze())
})

test('motion: explode steps play in order with trails, and collapse puts everything back', async ({ app, page }) => {
  await app.open()
  await plateAndBar(app)
  await app.tab('Assemble')
  await app.ribbon('Explode Steps').click()
  await expect(page.getByTestId('asm-explode')).toBeVisible()
  await expect(page.getByTestId('explode-toggle')).toBeDisabled()

  // step 1: the bar goes up; step 2: the plate goes down
  await page.getByTestId('comp-o2').click()
  await page.getByTestId('explode-add').click()
  await app.ev((c) => c.assembly.rt.getState().setExplode(0))
  await page.getByTestId('comp-o1').click()
  await page.locator('.asm-row', { has: page.getByTestId('explode-add') }).locator('.sel').click()
  await page.getByRole('option', { name: '-Z' }).click()
  await page.getByTestId('explode-add').click()
  const steps = await app.ev((c) => c.doc.getState().assembly.explode.steps)
  expect(steps.map((s: { occs: string[]; direction: number[] }) => [s.occs, s.direction])).toEqual([[['o2'], [0, 0, 1]], [['o1'], [0, 0, -1]]])
  const dist = steps[0].distance
  await app.ev((c) => c.assembly.rt.getState().setExplode(0))

  const bar = await barId(app)
  const lowz = async () => (await worldBox(app, bar)).lo[2]
  const plateId = await app.ev((c) => c.doc.getState().geometry.find((b: { name: string }) => b.name === 'Plate').id)
  const plateZ = async () => (await worldBox(app, plateId)).lo[2]
  expect(await lowz()).toBeCloseTo(0, 6)

  // the toggle animates on the nav clock: halfway through the two steps the first is done, the second not started
  await app.ev((c) => c.nav.freeze())
  await page.getByTestId('explode-toggle').click()
  await app.ev((c) => c.nav.tick(450))
  await app.ev((c) => c.assembly.motion.tickAnimations())
  await expect.poll(async () => +(await app.ev((c) => c.assembly.rt.getState().explode)).toFixed(3)).toBeCloseTo(0.5, 2)
  expect(await lowz()).toBeCloseTo(dist, 3)
  expect(await plateZ()).toBeCloseTo(0, 3)
  await app.ev((c) => c.nav.tick(2000))
  await app.ev((c) => c.assembly.motion.tickAnimations())
  await expect(page.getByTestId('explode-toggle')).toHaveText('Collapse')
  expect(await lowz()).toBeCloseTo(dist, 3)
  expect(await plateZ()).toBeCloseTo(-dist, 3)
  // the trails of both steps are drawn
  const trails = await app.ev((c) => c.three.scene.getObjectByName('explode-trails')?.children.length)
  expect(trails).toBe(2)
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  await app.shot('exploded-view')

  // collapse
  await page.getByTestId('explode-toggle').click()
  await app.ev((c) => c.nav.tick(2000))
  await app.ev((c) => c.assembly.motion.tickAnimations())
  await expect(page.getByTestId('explode-toggle')).toHaveText('Explode')
  expect(await lowz()).toBeCloseTo(0, 6)
  expect(await plateZ()).toBeCloseTo(0, 6)
  await app.ev((c) => c.nav.unfreeze())

  // the explode view is a presentation: it is saved with the document but the model itself never moved
  expect(await app.ev((c) => c.doc.getState().assembly.occurrences.every((o: { transform: number[] }) => o.transform[14] === 0))).toBe(true)
})
