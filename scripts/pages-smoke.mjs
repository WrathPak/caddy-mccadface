// smoke check for the production build served under a subpath.
// usage: node scripts/pages-smoke.mjs http://localhost:4173/caddy-mccadface/
import { chromium } from '@playwright/test'

const url = process.argv[2] || 'http://localhost:4173/caddy-mccadface/'
const base = new URL(url).pathname

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const problems = []
const bad = []
page.on('console', (m) => { if (m.type() === 'error') problems.push('console.error: ' + m.text()) })
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
page.on('response', (r) => {
  const u = new URL(r.url())
  if (u.origin === new URL(url).origin && (r.status() >= 400 || !u.pathname.startsWith(base))) bad.push(r.status() + ' ' + u.pathname)
})

try {
  await page.goto(url)
  await page.locator('canvas').first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(1000)
  await page.locator('.ribbon-body').getByRole('button', { name: 'Box' }).first().click()
  await page.locator('.inspector-foot').getByRole('button', { name: 'OK' }).click()
  await page.locator('.status').filter({ hasText: 'Tris: 12' }).waitFor({ timeout: 60_000 })

  const manifestHref = await page.locator('link[rel=manifest]').getAttribute('href')
  const manifest = await (await page.request.get(new URL(manifestHref, url).href)).json()
  const scope = manifest.scope ?? new URL(manifest.start_url, new URL(manifestHref, url)).pathname
  if (!String(scope).startsWith(base)) problems.push('manifest scope is ' + scope)
  const sw = await page.evaluate(async () => {
    const r = await navigator.serviceWorker?.getRegistration()
    return r ? r.scope : null
  })
  console.log('manifest scope:', scope, ' sw scope:', sw)
} catch (e) {
  problems.push('smoke failed: ' + e.message)
}
await browser.close()

if (bad.length) problems.push('bad or out-of-base requests: ' + bad.join(', '))
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('ok: loaded under ' + base + ', box created, no console errors')
