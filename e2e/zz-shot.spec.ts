import { test } from './helpers'
import { boxTris, importStl, writeStl } from './mesh-kit'
import { clickWorld } from './solids-kit'

test('shots', async ({ app }) => {
  test.setTimeout(120000)
  for (const w of [1280, 1600]) {
    await app.page.setViewportSize({ width: w, height: 900 })
    await app.open()
    await importStl(app, writeStl('shotbox', boxTris(40, 30, 20, [0, 0, 0], 4)))
    await app.tab('Mesh')
    await app.page.locator('.tree-row', { hasText: /shotbox/ }).first().click()
    await app.page.waitForTimeout(800)
    await app.page.screenshot({ path: `e2e/screenshots/zz-mesh-${w}.png` })
    await app.ribbon('Plane Cut').first().click()
    await clickWorld(app, [20, 15, 20])
    await app.page.waitForTimeout(1200)
    await app.page.screenshot({ path: `e2e/screenshots/zz-cut-${w}.png` })
  }
})
