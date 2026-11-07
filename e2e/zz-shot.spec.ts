import { test } from './helpers'

for (const w of [1280, 1600]) {
  test(`ribbon ${w}`, async ({ app, page }) => {
    await page.setViewportSize({ width: w, height: 800 })
    await app.open()
    await page.screenshot({ path: `e2e/results/ribbon-${w}.png`, clip: { x: 0, y: 0, width: w, height: 190 } })
  })
}
