import { test, expect, type App } from './helpers'

/** Index of the box face whose outward normal is (nx, ny, nz). */
async function faceIndex(app: App, n: [number, number, number]) {
  return app.ev((c, n) => {
    const b = c.doc.getState().geometry[0]
    const m = b.mesh
    for (let t = 0; t < m.indices.length / 3; t++) {
      const i = m.indices[t * 3] * 3
      if (Math.abs(m.normals[i] - n[0]) + Math.abs(m.normals[i + 1] - n[1]) + Math.abs(m.normals[i + 2] - n[2]) < 1e-3) return m.faceIds[t] as number
    }
    return -1
  }, n)
}

/** Box, then select the given side faces and open the Hair dialog on them. */
async function startHairOn(app: App, normals: [number, number, number][]) {
  await app.open()
  await app.ev((c) => c.runCommand('solid.box'))
  await app.ok()
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
  const id = await app.ev((c) => c.doc.getState().geometry[0].id as string)
  const sel = []
  for (const n of normals) sel.push({ kind: 'face', id, index: await faceIndex(app, n) })
  await app.ev((c, sel) => c.ui.getState().setSelection(sel), sel)
  await app.tab('Hair')
  await app.ribbon(/^Hair$/).first().click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Hair')
}

const strands = (app: App) => app.ev((c) => c.hair.getState().result?.stats?.strands ?? 0)

test('hair: faces -> preview -> tweak density/length -> OK gives one merged body', async ({ app, page }) => {
  await startHairOn(app, [[1, 0, 0]])
  const base = await app.tris()
  await expect.poll(() => strands(app), { timeout: 45_000 }).toBeGreaterThan(0)
  const strands1 = await strands(app)
  await expect(page.locator('.status')).toContainText('strands')
  // the preview draws clean opaque strands and the translucent muted-red sacrificial wall
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
  expect(meshes.strands).toMatchObject({ transparent: false, opacity: 1, hasNormals: true, noAo: true })
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  await app.shot('hair-preview')

  // change density and length: the preview regenerates
  await app.field('Density', '4')
  await expect.poll(() => strands(app), { timeout: 45_000 }).toBeLessThan(strands1)
  await app.field('Length', '12')
  await expect.poll(() => app.ev((c) => c.hair.getState().error)).toBeNull()
  await page.waitForTimeout(800)
  await app.shot('hair-preview-tweaked')

  await app.ok()
  await page.waitForFunction(() => !(window as any).__caddy.doc.getState().regenerating) // eslint-disable-line
  const feats = await app.features()
  expect(feats.map((f) => [f.type, f.state]), JSON.stringify(feats.map((f) => f.error))).toEqual([['box', 'ok'], ['hair', 'ok']])
  expect(feats[1].params.density).toBe(4)
  expect(feats[1].params.length).toBe(12)
  const bodies = await app.bodies()
  expect(bodies, 'strands + wall merged into the target').toHaveLength(1)
  expect(bodies[0].tris).toBeGreaterThan(base)
  await app.ev((c) => c.runCommand('view.home'))
  await app.shot('hair-done')
})

test('hair: the dialog explains itself - presets, help hints, direction list, printable-size warning', async ({ app, page }) => {
  await startHairOn(app, [[1, 0, 0]])
  await expect.poll(() => strands(app), { timeout: 45_000 }).toBeGreaterThan(0)
  const dlg = app.inspector()
  // Basic sections are open, the rest is collapsed behind Advanced-style headings
  for (const name of ['Direction', 'Strands', 'Wall']) await expect(dlg.locator('.section-head', { hasText: name })).toHaveAttribute('aria-expanded', 'true')
  for (const name of ['Printing', 'Pattern and edges', 'Styling', 'Advanced']) await expect(dlg.locator('.section-head', { hasText: name })).toHaveAttribute('aria-expanded', 'false')
  // the five direction options, each with a one-line description
  const opts = dlg.locator('.opt-row')
  await expect(opts).toHaveCount(5)
  for (const label of ['Perpendicular to each face', 'Blend across faces', 'Fan from axis', 'Fixed direction', 'Toward / away from point']) await expect(opts.filter({ hasText: label })).toHaveCount(1)
  await expect(opts.first().locator('.opt-desc')).not.toHaveText('')
  await expect(opts.first()).toHaveAttribute('aria-checked', 'true')
  // direction-specific fields appear with the option
  await opts.filter({ hasText: 'Blend across faces' }).click()
  await expect(dlg.locator('.field-label', { hasText: 'Blend distance' })).toBeVisible()
  await opts.filter({ hasText: 'Fixed direction' }).click()
  await expect(dlg.locator('.field-label', { hasText: 'Direction' }).last()).toBeVisible()
  expect(await app.ev((c) => !!c.hair.getState().glyphs)).toBe(true)
  await page.waitForTimeout(500)
  await app.ev((c) => c.runCommand('view.frame'))
  await app.cameraStable()
  await app.shot('hair-fixed-direction')
  expect(await app.ev((c) => !!c.hair.getState().fixed)).toBe(true)
  await opts.filter({ hasText: 'Perpendicular to each face' }).click()

  // every field has a help text: tooltip on the label and a hint line while focused
  const dens = dlg.locator('.field', { has: page.locator('.field-label', { hasText: 'Density' }) }).first()
  await expect(dens.locator('.field-label')).toHaveAttribute('title', /Strands per square centimetre/)
  await dens.locator('input').focus()
  await expect(dlg.getByTestId('field-hint')).toContainText('Strands per square centimetre')
  await app.shot('hair-help-hint')
  await dens.locator('input').blur()
  await expect(dlg.getByTestId('field-hint')).toHaveCount(0)

  // presets fill the settings
  await dlg.locator('.field', { has: page.locator('.field-label', { hasText: 'Presets' }) }).locator('button.sel').click()
  await page.getByRole('option', { name: 'Short fur' }).click()
  await expect.poll(() => app.ev((c) => c.hair.getState().result?.stats?.strands ?? 0), { timeout: 45_000 }).toBeGreaterThan(0)
  await expect(dlg.locator('.field', { has: page.locator('.field-label', { hasText: /^Length$/ }) }).locator('input')).toHaveValue('6')

  // below the printable size: a warning, not an error
  await app.field('Width', '0.2')
  await expect(dlg.getByTestId('inspector-warning').first()).toContainText('printable minimum')
  await expect(dlg.getByRole('button', { name: 'OK' })).toBeEnabled()
})

for (const mode of ['perFace', 'blend'] as const) {
  test(`hair: two adjacent faces, ${mode === 'perFace' ? 'Perpendicular' : 'Blend'} - clean strands and wall`, async ({ app, page }) => {
    await startHairOn(app, [[1, 0, 0], [0, -1, 0]])
    const dlg = app.inspector()
    await dlg.locator('.opt-row', { hasText: mode === 'perFace' ? 'Perpendicular to each face' : 'Blend across faces' }).click()
    await app.field('Length', '10')
    await app.field('Density', '6')
    await expect.poll(() => strands(app), { timeout: 45_000 }).toBeGreaterThan(5)
    await page.waitForTimeout(600)
    expect(await app.ev((c) => c.hair.getState().error)).toBeNull()
    const st = await app.ev((c) => c.hair.getState().result.stats)
    expect(st.edgeRejected).toBeGreaterThanOrEqual(0)
    // the wall is closed and sized like the faces
    const wall = await app.ev((c) => {
      const p = c.hair.getState().result.wall.positions
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[i + k]); hi[k] = Math.max(hi[k], p[i + k]) }
      return { lo, hi }
    })
    expect(wall.hi[2] - wall.lo[2]).toBeGreaterThan(20)
    await app.ev((c) => c.hair.setState({ showGlyphs: false }))
    for (const [view, label] of [['top', 'top'], ['home', '34']] as const) {
      // the plan view is orthographic: in perspective a 28 mm tall wall shows its inner face and looks several times too thick
      await app.ev((c, v) => { if ((v === 'top') !== (c.ui.getState().projection === 'orthographic')) c.runCommand('view.ortho'); c.runCommand('view.' + v); c.runCommand('view.frame') }, view)
      await app.cameraStable()
      await app.shot(`hair-corner-${mode}-${label}`)
    }
  })
}

test('hair: a surface the settings cannot grow on explains why inside the dialog; Fixed direction starts along the face normal', async ({ app, page }) => {
  await startHairOn(app, [[0, 0, 1]]) // the top face: print-aware strands are horizontal, so none can grow
  const dlg = app.inspector()
  await expect(dlg.getByTestId('inspector-notice')).toContainText('Rows', { timeout: 30_000 })
  await expect(page.locator('.status')).toContainText('Hair:')
  await dlg.locator('.section-head', { hasText: 'Pattern and edges' }).click()
  await dlg.getByRole('radio', { name: 'Random' }).click()
  await expect(dlg.getByTestId('inspector-notice')).toContainText('Print-aware', { timeout: 30_000 })
  // turning Print-aware off (Printing section) lets them grow and clears the message
  await dlg.locator('.section-head', { hasText: 'Printing' }).click()
  await dlg.getByRole('checkbox', { name: 'Print-aware' }).click()
  await expect.poll(() => strands(app), { timeout: 45_000 }).toBeGreaterThan(0)
  await expect(dlg.getByTestId('inspector-notice')).toHaveCount(0)
  // Fixed direction: the arrow starts along the selected face's normal (+Z here)
  await dlg.locator('.opt-row', { hasText: 'Fixed direction' }).click()
  await expect.poll(() => app.ev((c) => c.hair.getState().fixed?.dir ?? null)).toEqual([0, 0, 1])
})

test('hair: every wall shape builds on two faces (follow with sharp and rounded corners, through tips, flat plane, cylinder)', async ({ app, page }) => {
  await startHairOn(app, [[1, 0, 0], [0, -1, 0]])
  const dlg = app.inspector()
  await app.field('Length', '10')
  await app.field('Spread', '6')
  const shape = async (name: string) => {
    await dlg.locator('.field', { has: page.locator('.field-label', { hasText: /^Shape$/ }) }).locator('button.sel').click()
    await page.getByRole('option', { name }).click()
  }
  for (const [name, tag] of [['Through tips', 'tips'], ['Flat plane', 'planar'], ['Cylinder', 'cylinder'], ['Follow faces', 'follow']] as const) {
    await shape(name)
    await expect.poll(() => app.ev((c) => c.hair.getState().result?.stats?.strands ?? 0), { timeout: 45_000 }).toBeGreaterThan(20)
    await page.waitForTimeout(700)
    expect(await app.ev((c) => c.hair.getState().error), name).toBeNull()
    expect(await app.ev((c) => !!c.hair.getState().result.wall), name).toBe(true)
    await app.ev((c) => { c.hair.setState({ showGlyphs: false }); c.runCommand('view.home'); c.runCommand('view.frame') })
    await app.cameraStable()
    await app.shot('hair-wall-' + tag)
  }
  await dlg.getByRole('radio', { name: 'Rounded' }).click()
  await page.waitForTimeout(900)
  expect(await app.ev((c) => c.hair.getState().error)).toBeNull()
  await app.shot('hair-wall-round-corners')
})
