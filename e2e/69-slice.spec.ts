/**
 * Slicing in the browser: pick the A1, change a setting in the full panel, slice a cube with the real OrcaSlicer engine (WebAssembly),
 * check the result card and the G-code, export the .gcode.3mf and check what is inside. Needs the engine files (the dev server fetches them).
 */
import fs from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { test, expect } from './helpers'

test('slice a cube on the A1 with a changed setting, then export the .gcode.3mf', async ({ app, page }) => {
  test.setTimeout(180_000)
  await app.open()
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 20, depth: 20, height: 20, position: [0, 0, 0] }))
  await app.idle()
  await app.tab('Print')
  await expect(page.locator('.ribbon-body').getByRole('button', { name: 'Slice', exact: true })).toBeVisible()
  await app.ribbon('Print Settings').click()
  const sheet = page.getByTestId('slice-sheet')
  await expect(sheet).toBeVisible()
  // the A1 is the default printer, with its default process and filament
  await expect(sheet.getByTestId('printer-picker')).toContainText('Bambu Lab A1')
  await expect(sheet.getByTestId('preset-process')).toContainText('0.20mm Standard @BBL A1', { timeout: 30_000 })
  await app.shot('slice-quick')

  // a setting in Orca's own Strength page: infill density
  await page.getByTestId('tab-process').click()
  await page.getByTestId('page-strength').click()
  const row = page.getByTestId('row-sparse_infill_density')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('input').first().fill('35%')
  await row.locator('input').first().press('Enter')
  await expect(row).toHaveAttribute('data-modified', 'true')
  await app.shot('slice-process')
  expect(await app.ev((c) => c.doc.getState().features.find((f: any) => f.type === 'printSettings').params.infill)).toBe(35) // eslint-disable-line

  await page.getByTestId('slice-go').click()
  // a finished slice opens on its layers; the summary card sits at the bottom right
  const card = page.getByTestId('slice-card')
  await expect(card).toHaveAttribute('data-status', 'done', { timeout: 120_000 })
  await expect(page.getByTestId('print-time')).toContainText('m')
  expect(Number(await page.getByTestId('layer-count').innerText())).toBeGreaterThanOrEqual(98)
  await expect(page.getByTestId('filament-usage')).toContainText('Bambu PLA Basic')
  await app.shot('slice-result')
  const gcode = await app.ev(async () => {
    const m = await import(/* @vite-ignore */ '/src/features/print/engine/sliceStore.ts')
    return new TextDecoder().decode(m.useSlice.getState().result!.gcode)
  })
  expect(gcode).toContain('; sparse_infill_density = 35%')
  expect(gcode).toContain('HEADER_BLOCK_START')

  // the document changes after the slice: the result is marked out of date
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 5, depth: 5, height: 5, position: [40, 0, 0] }))
  await expect(page.getByTestId('stale-badge')).toBeVisible()
  await app.idle()
  await page.getByTestId('reslice').click()
  await expect(card).toHaveAttribute('data-stale', 'false', { timeout: 120_000 })

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-gcode').click()])
  expect(dl.suggestedFilename()).toMatch(/\.gcode\.3mf$/)
  const z = unzipSync(new Uint8Array(fs.readFileSync((await dl.path())!)))
  expect(Object.keys(z).sort()).toEqual([
    '3D/3dmodel.model', '3D/Objects/object_1.model', '3D/Objects/object_2.model', '3D/_rels/3dmodel.model.rels', '[Content_Types].xml', '_rels/.rels',
    'Metadata/_rels/model_settings.config.rels', 'Metadata/model_settings.config', 'Metadata/pick_1.png', 'Metadata/plate_1.gcode', 'Metadata/plate_1.gcode.md5',
    'Metadata/plate_1.json', 'Metadata/plate_1.png', 'Metadata/plate_1_small.png', 'Metadata/plate_no_light_1.png', 'Metadata/project_settings.config',
    'Metadata/slice_info.config', 'Metadata/top_1.png',
  ].sort())
  expect(strFromU8(z['Metadata/plate_1.gcode.md5'])).toMatch(/^[0-9A-F]{32}$/)
  const cfg = JSON.parse(strFromU8(z['Metadata/project_settings.config']))
  expect(cfg.sparse_infill_density).toBe('35%')
  expect(cfg.printer_settings_id).toBe('Bambu Lab A1 0.4 nozzle')
  expect(strFromU8(z['Metadata/plate_1.gcode'])).toContain('; sparse_infill_density = 35%')
  expect(z['Metadata/plate_1.png'].length).toBeGreaterThan(2000)
})
