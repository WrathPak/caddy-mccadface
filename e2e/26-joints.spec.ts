import { test, expect } from './helpers'
import type { App } from './helpers'
import { addBox, addJoint, barId, jointsOf, plateAndBar, solved, worldBox } from './asm'

test('joints: pick two joint origins with snap points, preview, flip, and the bar lands on the plate', async ({ app, page }) => {
  await app.open()
  await plateAndBar(app)
  await app.tab('Assemble')
  await app.ribbon('Joint').first().click()
  await expect(page.locator('.panel-title', { hasText: 'Joint' })).toBeVisible()

  // origin 1: hover the plate's top face: its center lights up as a snap point, with a label
  const top = await app.project(0, 0, 4)
  await page.mouse.move(top.x + 3, top.y + 2)
  await page.mouse.move(top.x, top.y, { steps: 4 })
  await expect(page.getByTestId('snap-label')).toHaveText('Face center')
  await app.shot('joint-snap-hover')
  await page.mouse.click(top.x, top.y)
  await expect(page.getByTestId('sel-origin1')).toContainText('1 selected')

  // origin 2: the top face center of the bar
  const bar = await app.project(45, 0, 6)
  await page.mouse.move(bar.x, bar.y, { steps: 4 })
  await expect(page.getByTestId('snap-label')).toHaveText('Face center')
  await page.mouse.click(bar.x, bar.y)
  await expect(page.getByTestId('sel-origin2')).toContainText('1 selected')

  // the second component moves to the first origin while the dialog is open (live preview); flip turns it over
  await expect(page.getByTestId('info-typeHelp')).toContainText('fixed to each other')
  const flip = page.locator('.field', { has: page.locator('.field-label', { hasText: 'Flip' }) }).getByRole('checkbox')
  await flip.click()
  await expect.poll(async () => (await worldBox(app, await barId(app))).lo[2]).toBeCloseTo(4, 3)
  await app.shot('joint-dialog')
  await app.ok()

  const joints = await jointsOf(app)
  expect(joints).toHaveLength(1)
  expect(joints[0]).toMatchObject({ type: 'rigid', flip: true })
  const box = await worldBox(app, await barId(app))
  expect(box.lo).toEqual([-15, -3, 4])
  expect(box.hi).toEqual([15, 3, 10])
  await expect(page.getByTestId('joints-group')).toBeVisible()
  await expect(page.getByTestId('joint-' + joints[0].id)).toBeVisible()
})


test('joints: drive a revolute joint with its slider, limits stop it, reset goes to the rest value', async ({ app, page }) => {
  await app.open()
  await plateAndBar(app)
  await app.ev((c) => c.assembly.actions.setGrounded('o1', true))
  // hinge on the plate's top centre, at the bar's left end (bar runs x = 30..60)
  const limits = { angle: { enabled: true, min: -45, max: 60, rest: 20 } }
  const id = await addJoint(app, { name: 'Hinge', type: 'revolute', a: 'o1', b: 'o2', fa: [0, 0, 4], fb: [30, 0, 0], extra: { limits } })
  await app.tab('Assemble')
  await app.ribbon('Drive Joints').click()
  await expect(page.getByTestId('asm-hud')).toBeVisible()
  await expect(page.getByTestId('asm-joint-' + id)).toBeVisible()
  await app.shot('drive-joints')

  const thumb = page.getByTestId(`dof-slider-${id}-angle`).getByRole('slider')
  await thumb.focus()
  await page.keyboard.press('End')
  await expect.poll(async () => (await jointsOf(app))[0].values.angle).toBe(60)
  // the bar turned 60 degrees about the vertical axis through the hinge: its far end is at 30 along the rotated X
  const bar = await barId(app)
  const b60 = await worldBox(app, bar)
  expect(b60.lo[2]).toBeCloseTo(4, 3) // the hinge is on the plate's top (z = 4) and the bar's bottom is at the hinge
  expect(b60.hi[2]).toBeCloseTo(10, 3)
  expect(b60.hi[1]).toBeCloseTo(30 * Math.sin(Math.PI / 3) + 3 * Math.cos(Math.PI / 3), 3)
  await page.keyboard.press('Home')
  await expect.poll(async () => (await jointsOf(app))[0].values.angle).toBe(-45)
  // a typed value past the limit is held at it
  const field = page.getByTestId(`dof-${id}-angle`).locator('input')
  await field.click()
  await field.fill('200')
  await field.press('Enter')
  await expect.poll(async () => (await jointsOf(app))[0].values.angle).toBe(60)
  // reset: the rest value of the limits
  await page.getByRole('button', { name: 'Reset Hinge' }).click()
  await expect.poll(async () => (await jointsOf(app))[0].values.angle).toBe(20)
  // each of those is one undo step
  await app.ev((c) => c.doc.getState().undo())
  await expect.poll(async () => (await jointsOf(app))[0].values.angle).toBe(60)
})

test('joints: every joint type moves the way its name says', async ({ app }) => {
  await app.open()
  await plateAndBar(app)
  await app.ev((c) => c.assembly.actions.setGrounded('o1', true))
  const bar = await barId(app)
  const tip = async () => (await worldBox(app, bar))
  const id = await addJoint(app, { name: 'J', type: 'slider', a: 'o1', b: 'o2', fa: [0, 0, 4], fb: [45, 0, 0] })
  const set = (values: Record<string, number>) => app.ev((c, a) => c.assembly.actions.setJointValues({ [a.id]: a.values }), { id, values })
  await set({ distance: 12 })
  expect((await tip()).lo[2]).toBeCloseTo(16, 3) // along the joint axis (Z)
  await app.ev((c, id) => c.assembly.actions.updateJoint(id, { type: 'pinSlot', values: { angle: 90, slide: 5 }, limits: c.assembly.actions.newJointDefaults('pinSlot').limits }), id)
  const pin = await tip()
  expect(pin.lo[0]).toBeCloseTo(-3 + 5, 3) // turned 90 degrees about Z, then 5 along the joint's X
  await app.ev((c, id) => c.assembly.actions.updateJoint(id, { type: 'planar', values: { x: 10, y: -4, angle: 0 }, limits: c.assembly.actions.newJointDefaults('planar').limits }), id)
  const pl = await tip()
  expect(pl.lo[0]).toBeCloseTo(-15 + 10, 3) // the bar's centre sits on the joint origin: x = 0 + 10
  expect(pl.lo[1]).toBeCloseTo(-3 - 4, 3)
  await app.ev((c, id) => c.assembly.actions.updateJoint(id, { type: 'ball', values: { roll: 0, pitch: 0, yaw: 90 }, limits: c.assembly.actions.newJointDefaults('ball').limits }), id)
  expect((await tip()).hi[1]).toBeCloseTo(15, 3) // turned 90 degrees about its centre: the 30 long bar now runs along Y
})

test('joints: conflicting joints show an over-constrained error on the joint, the panel and the component', async ({ app, page }) => {
  await app.open()
  await plateAndBar(app)
  await app.ev((c) => c.assembly.actions.setGrounded('o1', true))
  const a = await addJoint(app, { name: 'Weld A', type: 'rigid', a: 'o1', b: 'o2', fa: [0, 0, 4], fb: [45, 0, 0] })
  const b = await addJoint(app, { name: 'Weld B', type: 'rigid', a: 'o1', b: 'o2', fa: [10, 0, 4], fb: [45, 0, 0] })
  const s = await solved(app)
  expect(s.over).toBe(true)
  expect(s.errors[b] ?? s.errors[a]).toMatch(/over-constrained/i)
  await expect(page.getByTestId('comp-error-o2')).toBeVisible()
  await app.tab('Assemble')
  await app.ribbon('Drive Joints').click()
  await expect(page.getByTestId('joint-error-' + (s.errors[b] ? b : a))).toContainText(/over-constrained/i)
  await app.shot('over-constrained')
  // deleting the conflicting joint clears every error
  await page.getByRole('button', { name: 'Delete Weld B' }).click()
  await expect.poll(async () => (await solved(app)).over).toBe(false)
  await expect(page.getByTestId('comp-error-o2')).toHaveCount(0)
})

test('joints: an as-built joint keeps both components where they are', async ({ app, page }) => {
  await app.open()
  await plateAndBar(app)
  const before = await worldBox(app, await barId(app))
  await app.tab('Assemble')
  await app.ribbon('As-built Joint').click()
  await page.getByTestId('comp-o1').click()
  await page.getByTestId('comp-o2').click()
  await expect(page.getByTestId('sel-comp1')).toContainText('1 selected')
  await expect(page.getByTestId('sel-comp2')).toContainText('1 selected')
  const top = await app.project(0, 0, 4)
  await page.mouse.move(top.x, top.y, { steps: 4 })
  await page.mouse.click(top.x, top.y)
  await expect(page.getByTestId('sel-origin')).toContainText('1 selected')
  await app.ok()
  const joints = await jointsOf(app)
  expect(joints).toHaveLength(1)
  expect(joints[0].type).toBe('revolute')
  expect(await worldBox(app, await barId(app))).toEqual(before) // nothing moved
  // and the joint turns the bar about the origin it was made at (the plate's top centre)
  await app.ev((c, id) => c.assembly.actions.setJointValues({ [id]: { angle: 90 } }), joints[0].id)
  const turned = await worldBox(app, await barId(app))
  expect(turned.lo[0]).toBeCloseTo(-3, 3)
  expect(turned.hi[0]).toBeCloseTo(3, 3)
  expect(turned.lo[1]).toBeCloseTo(30, 3)
  expect(turned.hi[1]).toBeCloseTo(60, 3)
})

test('joints: a motion link makes one joint follow another by a ratio', async ({ app, page }) => {
  await app.open()
  await plateAndBar(app)
  await app.ev((c) => c.assembly.actions.setGrounded('o1', true))
  const j1 = await addJoint(app, { name: 'Drive', type: 'revolute', a: 'o1', b: 'o2', fa: [0, 0, 4], fb: [30, 0, 0] })
  // a second pair so there is something to follow
  await addBox(app, 'Gear', [10, 10, 4], [0, 60, 0])
  const gear = (await app.ev((c) => c.doc.getState().geometry.map((b: { id: string; name: string }) => [b.id, b.name]))).find((x: string[]) => x[1] === 'Gear')[0] as string
  await app.ev((c, id) => c.assembly.actions.componentsFromBodies([id]), gear)
  const j2 = await addJoint(app, { name: 'Follow', type: 'revolute', a: 'o1', b: 'o3', fa: [0, 60, 4], fb: [0, 0, 0] })
  await app.tab('Assemble')
  await app.ribbon('Motion Link').click()
  await page.locator('.field', { has: page.locator('.field-label', { hasText: 'Driver' }) }).locator('.sel').click()
  await page.getByRole('option', { name: 'Drive: Angle' }).click()
  await page.locator('.field', { has: page.locator('.field-label', { hasText: 'Follower' }) }).locator('.sel').click()
  await page.getByRole('option', { name: 'Follow: Angle' }).click()
  await app.field('Ratio', '-2')
  await app.ok()
  const links = await app.ev((c) => c.doc.getState().assembly.links)
  expect(links).toHaveLength(1)
  expect(links[0]).toMatchObject({ a: { joint: j1, key: 'angle' }, b: { joint: j2, key: 'angle' }, ratio: -2 })
  await app.ev((c, id) => c.assembly.actions.setJointValues({ [id]: { angle: 30 } }), j1)
  expect((await solved(app)).values[j2].angle).toBeCloseTo(-60, 6)
  // the followed joint cannot be dragged on its own: its slider is off
  await app.ribbon('Drive Joints').click()
  await expect(page.getByTestId(`dof-${j2}-angle`).locator('input')).toBeDisabled()
  await expect(page.getByTestId('link-' + links[0].id)).toBeVisible()
})
