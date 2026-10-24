import { test, expect } from './helpers'

test('Configurations: a table of parameter sets, switched from the Browser, saved with the document and exported one by one', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => {
    const d = c.doc.getState()
    d.setUserParams([{ name: 'w', expr: '20' }, { name: 'h', expr: '10' }])
    d.addFeature('box', { width: 'w', depth: 20, height: 'h', position: [0, 0, 0] })
  })
  await app.idle()
  expect((await app.bbox()).max[0] - (await app.bbox()).min[0]).toBeCloseTo(20, 3)

  // the dialog: one row per configuration, one column per parameter
  await page.locator('.tree-row', { hasText: 'Add configurations...' }).click()
  const dlg = page.getByRole('dialog', { name: 'Configurations' })
  await expect(dlg).toBeVisible()
  await page.getByTestId('config-add').click()
  await page.getByTestId('config-add').click()
  await page.getByTestId('config-name-0').fill('Small')
  await page.getByTestId('config-0-w').fill('10')
  await page.getByTestId('config-name-1').fill('Large')
  await page.getByTestId('config-1-w').fill('60')
  await page.getByTestId('config-1-h').fill('25')
  await app.shot('configurations-dialog')
  await page.getByTestId('config-ok').click()
  await expect(dlg).toBeHidden()
  await expect(page.getByTestId('config-row-Small')).toBeVisible()
  await expect(page.getByTestId('config-row-Large')).toBeVisible()

  await page.getByTestId('config-row-Large').click()
  await app.idle()
  let bb = await app.bbox()
  expect(bb.max[0] - bb.min[0]).toBeCloseTo(60, 3)
  expect(bb.max[2] - bb.min[2]).toBeCloseTo(25, 3)
  await expect(page.getByTestId('configs-group')).toContainText('Large')
  await app.shot('configuration-large')
  await page.getByTestId('config-row-Small').click()
  await app.idle()
  bb = await app.bbox()
  expect(bb.max[0] - bb.min[0]).toBeCloseTo(10, 3)
  expect(bb.max[2] - bb.min[2]).toBeCloseTo(10, 3)
  await page.getByTestId('config-row-base').click()
  await app.idle()
  bb = await app.bbox()
  expect(bb.max[0] - bb.min[0]).toBeCloseTo(20, 3)

  // the active configuration is part of the document: save and load keep it, undo steps back through the switches
  await page.getByTestId('config-row-Large').click()
  await app.idle()
  const round = await app.ev(async (c) => {
    const bytes = await c.serializeProject(false)
    const p = c.parseProject(bytes)
    return { active: p.data.activeConfig, names: p.data.configs.map((x: any) => x.name), large: p.data.configs[1].values } // eslint-disable-line
  })
  expect(round).toEqual({ active: 'Large', names: ['Small', 'Large'], large: { w: '60', h: '25' } })
  await app.ev((c) => c.doc.getState().undo())
  await app.idle()
  expect(await app.ev((c) => c.doc.getState().activeConfig)).toBeNull()

  // export: one file per configuration
  const names: string[] = []
  page.on('download', (d) => names.push(d.suggestedFilename()))
  await app.ribbon('Export').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Export')
  await app.inspector().getByRole('radio', { name: 'Every configuration' }).click()
  await app.shot('export-configurations')
  await app.ok()
  await expect.poll(() => names.length, { timeout: 30000 }).toBe(2)
  expect(names.sort()).toEqual(['Untitled-Large.stl', 'Untitled-Small.stl'])
  // and the document is left as it was
  expect(await app.ev((c) => c.doc.getState().activeConfig)).toBeNull()
  bb = await app.bbox()
  expect(bb.max[0] - bb.min[0]).toBeCloseTo(20, 3)
})
