import fs from 'node:fs'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { test, expect } from './helpers'
import type { App } from './helpers'
import { addBox } from './asm'

const stateOf = (app: App) => app.ev((c) => {
  const d = c.doc.getState()
  // the assembled pose (the instance being edited is drawn at its own origin, which is not what is saved)
  const place = c.assembly.instances.placeAssembly(d.assembly, {}, null, 0, d.geometry)
  return {
    assembly: JSON.parse(JSON.stringify(d.assembly)),
    features: d.features.map((f: { id: string; type: string; name: string; component?: string; params: unknown }) => [f.id, f.type, f.name, f.component ?? null, f.params]),
    worlds: Object.fromEntries(Object.entries(place.worlds).map(([k, m]) => [k, (m as number[]).map((v) => +v.toFixed(6))])),
    frameErrors: place.frameErrors,
    activeOcc: d.activeOcc,
    undo: d.undoDepth,
    bodies: d.geometry.map((b: { id: string; component?: string }) => [b.id, b.component ?? null]),
  }
})

test('file: the component tree, instances, joints, links, explode steps and the motion study survive save and open', async ({ app, page }, info) => {
  await app.open()
  // plate (grounded) + a bar component placed twice, hinged on the plate with joints snapped to faces
  const base = await app.ev((c) => c.assembly.actions.newComponent('Plate'))
  await addBox(app, 'Plate', [40, 40, 4])
  await app.ev((c) => c.assembly.actions.activateOcc(null))
  const bar = await app.ev((c) => c.assembly.actions.newComponent('Bar'))
  await addBox(app, 'Bar', [30, 6, 6], [200, 0, 0])
  await app.ev((c) => c.assembly.actions.activateOcc(null))
  await app.ev((c) => c.assembly.actions.instanceOf('o2', 0))
  await app.ev((c) => c.assembly.actions.setGrounded('o1', true))
  // joints from real snap points: the plate's top face centre and the bar's bottom face centre
  await app.ev((c) => {
    const geo = c.doc.getState().geometry
    const plate = geo.find((b: { name: string }) => b.name === 'Plate'), barBody = geo.find((b: { name: string }) => b.name === 'Bar')
    const top = c.assembly.snaps.snapPoints(plate).find((p: { kind: string; z: number[] }) => p.kind === 'face' && p.z[2] > 0.99)
    const bottom = c.assembly.snaps.snapPoints(barBody).find((p: { kind: string; z: number[] }) => p.kind === 'face' && p.z[2] < -0.99)
    const mk = (name: string, to: string, off: number[]) => c.assembly.actions.addJoint({
      name, type: 'revolute', flip: true, offset: off, angle: 0, ...c.assembly.actions.newJointDefaults('revolute'),
      a: { occ: 'o1', frame: c.assembly.snaps.snapFrame(top), snap: c.assembly.snaps.snapSpec(plate, top, 'o1') },
      b: { occ: to, frame: c.assembly.snaps.snapFrame(bottom), snap: c.assembly.snaps.snapSpec(barBody, bottom, to) },
    })
    mk('Hinge 1', 'o2', [-12, 0, 0])
    mk('Hinge 2', 'o3', [12, 0, 0])
  })
  await app.ev((c) => c.assembly.actions.setJointValues({ j1: { angle: 40 } }))
  await app.ev((c) => c.assembly.actions.addLink({ name: 'Mirror', a: { joint: 'j1', key: 'angle' }, b: { joint: 'j2', key: 'angle' }, ratio: -1 }))
  await app.ev((c) => c.assembly.actions.addExplodeStep({ name: 'Lift bars', occs: ['o2', 'o3'], direction: [0, 0, 1], distance: 30, trail: true }))
  await app.ev((c) => c.assembly.actions.setMotionTrack({ joint: 'j1', key: 'angle', frames: [{ t: 0, v: 0 }, { t: 3, v: 80 }] }))
  await app.ev((c) => c.assembly.actions.setMotionSettings({ duration: 3, loop: true }))
  await app.ev((c) => c.assembly.actions.activateOcc('o2'))
  await app.idle()
  const before = await stateOf(app)
  expect(before.assembly.joints).toHaveLength(2)
  expect(before.worlds.o3).not.toEqual(before.worlds.o2)

  const [dl] = await Promise.all([page.waitForEvent('download'), app.ribbon('Save').click()])
  const file = path.join(path.dirname(info.outputPath('x')), 'assembly.caddy')
  await dl.saveAs(file)
  expect(fs.statSync(file).size).toBeGreaterThan(500)

  await page.reload()
  await app.open()
  expect((await stateOf(app)).assembly.occurrences).toEqual([])
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Open...').click()])
  await chooser.setFiles(file)
  await expect.poll(async () => (await stateOf(app)).bodies.length).toBe(2)
  await app.idle()
  const after = await stateOf(app)
  expect(after.assembly).toEqual(before.assembly)
  expect(after.features).toEqual(before.features)
  expect(after.worlds).toEqual(before.worlds)
  expect(after.bodies).toEqual(before.bodies)
  expect(after.frameErrors).toEqual({}) // the joint origins found their faces again
  expect(after.activeOcc).toBeNull() // opening leaves the root active
  expect(after.undo).toBe(0)
  await expect(page.getByTestId('comp-o1')).toBeVisible()
  await expect(page.getByTestId('comp-o2')).toContainText('Bar:1')
  await expect(page.getByTestId('comp-o3')).toContainText('Bar:2')
  await expect(page.getByTestId('joint-j2')).toBeVisible()
  await expect(page.getByTestId('link-l1')).toBeVisible()
  await expect(page.getByTestId('tl-sec-c1')).toBeVisible()
  // the explode view and the motion study are still there and work
  await app.ev((c) => c.assembly.rt.getState().setExplode(1))
  expect(await app.ev((c) => c.assembly.place.currentPlacement().worlds.o2[14])).toBeCloseTo(before.worlds.o2[14] + 30, 4)
  await app.ev((c) => c.assembly.rt.getState().setExplode(0))
  await app.tab('Assemble')
  await app.ribbon('Motion Study').click()
  await expect(page.getByTestId('asm-motion')).toContainText('3.00 s')
  await app.shot('assembly-reopened')
})

test('file: a document saved before assemblies opens as one root component and can grow components afterwards', async ({ app, page }, info) => {
  await app.open()
  const legacy = zipSync({
    'document.json': strToU8(JSON.stringify({
      format: 1, app: 'CADdy McCADFace', name: 'Old', rollback: 2, userParams: [], bodyNames: {}, configs: [], activeConfig: null,
      features: [
        { id: 'f1', type: 'box', name: 'Block', suppressed: false, params: { width: 30, depth: 20, height: 10, position: [0, 0, 0] } },
        { id: 'f2', type: 'box', name: 'Pin', suppressed: false, params: { width: 4, depth: 4, height: 14, position: [0, 0, 10] } },
      ],
    })),
  })
  const file = info.outputPath('old.caddy')
  fs.writeFileSync(file, Buffer.from(legacy))
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), app.ribbon('Open...').click()])
  await chooser.setFiles(file)
  await expect.poll(async () => (await stateOf(app)).bodies.length).toBe(2)
  const s = await stateOf(app)
  expect(s.assembly.components.map((c: { id: string }) => c.id)).toEqual(['root'])
  expect(s.assembly.occurrences).toEqual([])
  expect(s.bodies).toEqual([['f1', null], ['f2', null]])
  // no sections in the timeline, no components in the tree: it looks exactly like before
  await expect(page.locator('.tl-sec')).toHaveCount(0)
  await expect(page.getByTestId('components-group')).toHaveCount(0)
  await expect.poll(() => app.tris()).toBe(24)

  // turn the pin into a component: the document grows a tree without changing the geometry
  await app.tab('Assemble')
  await page.locator('.tree-row', { hasText: 'Pin' }).first().click()
  await app.ribbon('Components from Bodies').click()
  await expect(page.getByTestId('comp-o1')).toContainText('Pin')
  const grown = await stateOf(app)
  expect(grown.bodies).toEqual([['f1', null], ['f2', 'c1']])
  expect(grown.features.map((f: unknown[]) => f[3])).toEqual([null, 'c1'])
  await expect.poll(() => app.tris()).toBe(24)
})
