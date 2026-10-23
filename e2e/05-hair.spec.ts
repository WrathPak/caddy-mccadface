import { test, expect } from './helpers'

test('hair: select faces -> preview -> tweak density/length -> OK gives one merged body', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  const base = await app.tris()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()

  await app.tab('Hair')
  await app.ribbon('Select Faces').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Hair')
  await expect(page.locator('.hair-bar')).toBeVisible()
  await app.shot('hair-brush-ready')

  // brush across the top face (Z = 20)
  const c0 = await app.project(0, 0, 20)
  await page.mouse.move(c0.x - 60, c0.y)
  await page.mouse.down()
  await page.mouse.move(c0.x + 60, c0.y, { steps: 12 })
  await page.mouse.move(c0.x + 60, c0.y + 25, { steps: 4 })
  await page.mouse.move(c0.x - 60, c0.y + 25, { steps: 12 })
  await page.mouse.up()
  await expect(page.locator('.hair-count')).not.toHaveText('Nothing selected')

  // the preview appears
  await expect.poll(() => app.ev((c) => c.hair.getState().result?.stats?.strands ?? 0), { timeout: 45_000 }).toBeGreaterThan(0)
  const strands1 = await app.ev((c) => c.hair.getState().result.stats.strands as number)
  await expect(page.locator('.status')).toContainText('strands')
  // the preview draws clean opaque strands and, with "Enable wall" on, the translucent muted-red sacrificial wall
  await expect.poll(() => app.ev((c) => !!c.three.scene.getObjectByName('hair-wall'))).toBe(true)
  const meshes = await app.ev((c) => {
    const get = (n: string) => {
      const m = c.three.scene.getObjectByName(n)
      return m && { verts: m.geometry.attributes.position.count, hasNormals: !!m.geometry.attributes.normal, transparent: m.material.transparent, opacity: m.material.opacity, color: m.material.color.getHexString(), visible: m.visible, noAo: !!m.userData.noAo }
    }
    return { strands: get('hair-strands'), wall: get('hair-wall'), wallInResult: !!c.hair.getState().result.wall }
  })
  expect(meshes.wallInResult).toBe(true)
  expect(meshes.wall).toMatchObject({ transparent: true, visible: true, color: 'b0463e' })
  expect(meshes.wall.verts).toBeGreaterThanOrEqual(8)
  expect(meshes.wall.opacity).toBeGreaterThan(0.2)
  expect(meshes.wall.opacity).toBeLessThan(0.7)
  expect(meshes.strands).toMatchObject({ transparent: false, opacity: 1, hasNormals: true, noAo: true })
  await app.ev((c) => c.runCommand('view.frame')) // frame the strands and the wall together
  await app.cameraStable()
  await app.shot('hair-preview')

  // change density and length: the preview regenerates
  await app.field('Density', '6')
  await expect.poll(() => app.ev((c) => c.hair.getState().result?.stats?.strands ?? 0), { timeout: 45_000 }).toBeLessThan(strands1)
  await app.field('Length', '12')
  await expect.poll(() => app.ev((c) => c.hair.getState().error)).toBeNull()
  await page.waitForTimeout(800)
  await app.shot('hair-preview-tweaked')

  await app.ok()
  await page.waitForFunction(() => !(window as any).__caddy.doc.getState().regenerating) // eslint-disable-line
  const feats = await app.features()
  expect(feats.map((f) => [f.type, f.state]), JSON.stringify(feats.map((f) => f.error))).toEqual([['box', 'ok'], ['hair', 'ok']])
  expect(feats[1].params.density).toBe(6)
  expect(feats[1].params.length).toBe(12)
  const bodies = await app.bodies()
  expect(bodies, 'strands + wall merged into the target').toHaveLength(1)
  expect(bodies[0].tris).toBeGreaterThan(base)
  await app.ev((c) => c.runCommand('view.home'))
  await app.shot('hair-done')
})
