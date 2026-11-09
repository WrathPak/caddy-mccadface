/**
 * CADdy Link end to end: build the helper, run it with its simulated printers, pair the app, add a printer, slice a cube,
 * send it and watch the print progress in the printer card. The first test does it for the Bambu printer (with a filament
 * mapping), the second for a PrusaLink printer and a Prusa MK4S slice.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers'

let child: ChildProcess | null = null
let dir = ''
let port = 0
let out = ''

/** The pairing code to type now: the helper makes a new one after every successful pairing. */
const pairingCode = () => [...out.matchAll(/(?:Pairing code:|next pairing code is)\s*(\d{6})/g)].pop()?.[1] ?? ''

const freePort = () => new Promise<number>((res, rej) => {
  const s = net.createServer()
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)) })
  s.on('error', rej)
})

test.beforeAll(async () => {
  test.setTimeout(240_000)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-link-e2e-'))
  const exe = path.join(dir, process.platform === 'win32' ? 'caddy-link.exe' : 'caddy-link')
  execFileSync('go', ['build', '-o', exe, '.'], { cwd: path.resolve(import.meta.dirname, '../helper'), stdio: 'pipe', timeout: 200_000 })
  port = await freePort()
  child = spawn(exe, ['--mock', '--mock-speed', '10', '--port', String(port), '--config-dir', path.join(dir, 'cfg')], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', (d) => { out += String(d) })
  child.stderr!.on('data', (d) => { out += String(d) })
  const t0 = Date.now()
  while (!/CADdy Link ready/.test(out)) {
    if (Date.now() - t0 > 30_000) throw new Error(`the helper did not start:\n${out}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!pairingCode()) throw new Error(`no pairing code in the helper output:\n${out}`)
})

test.afterAll(() => {
  child?.kill()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* the exe may still be closing */ }
})

test('pair, add the simulated printer, slice a cube, send it and see it print', async ({ app, page }) => {
  test.setTimeout(240_000)
  await page.addInitScript((p) => { try { localStorage.setItem('caddy.link.port', String(p)) } catch { /* none */ } }, port)
  await app.open()
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 20, depth: 20, height: 20, position: [0, 0, 0] }))
  await app.idle()
  await app.tab('Print')

  // pair
  await app.ribbon('Printers').click()
  const panel = page.getByTestId('printers-panel')
  await expect(page.getByTestId('pair-input')).toBeVisible({ timeout: 20_000 })
  const code = pairingCode()
  await page.getByTestId('pair-input').fill(String((Number(code[0]) + 1) % 10) + code.slice(1))
  await expect(page.getByTestId('pair-error')).toBeVisible()
  await page.getByTestId('pair-input').fill(code)
  await expect(panel).toHaveAttribute('data-conn', 'ready', { timeout: 20_000 })

  // add the simulated printer from discovery
  await page.getByTestId('printers-add-first').click()
  await page.getByTestId('discover-go').click()
  await page.locator("[data-testid='found-printer'][data-serial='039MOCK00000001']").click({ timeout: 30_000 })
  await expect(page.getByTestId('add-code')).not.toHaveValue('')
  await page.getByTestId('add-go').click()
  const card = page.getByTestId('printer-card')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toHaveAttribute('data-online', 'true', { timeout: 30_000 })
  await expect(page.getByTestId('ams-slot-0')).toBeVisible()
  await expect(page.locator("[data-testid^='ams-slot-']")).toHaveCount(5)
  await page.getByTestId('printers-close').click()

  // slice, then send
  await app.ribbon(/^Slice$/).click()
  await expect(page.getByTestId('slice-card')).toHaveAttribute('data-status', 'done', { timeout: 150_000 })
  await page.getByTestId('send-to-printer').click()
  await expect(page.getByTestId('send-dialog')).toBeVisible()
  await expect(page.getByTestId('send-printer')).not.toHaveValue('')
  await expect(page.getByTestId('send-mismatch')).toHaveCount(0)
  await expect(page.getByTestId('send-go')).toBeEnabled({ timeout: 30_000 })
  const row = page.getByTestId('map-row-1')
  await expect(row).toBeVisible()
  expect(Number(await page.getByTestId('map-select-1').inputValue())).toBeGreaterThanOrEqual(0)
  await page.getByTestId('send-go').click()
  await expect(page.getByTestId('send-progress')).toHaveAttribute('data-stage', 'done', { timeout: 90_000 })
  await page.getByTestId('send-view').click()

  // the job shows in the printer card
  const live = page.getByTestId('printer-card')
  await expect(live).toHaveAttribute('data-state', /running|prepare|finish/, { timeout: 30_000 })
  await expect.poll(async () => Number(await live.getAttribute('data-percent')), { timeout: 60_000 }).toBeGreaterThan(0)
  await expect(page.getByTestId('printer-layer')).toContainText('Layer')
  await app.shot('printer-link-printing')
})

test('add the simulated PrusaLink printer, slice a cube for a Prusa MK4S, send it and see it print', async ({ app, page }) => {
  test.setTimeout(240_000)
  await page.addInitScript((p) => { try { localStorage.setItem('caddy.link.port', String(p)) } catch { /* none */ } }, port)
  await app.open()
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 20, depth: 20, height: 20, position: [0, 0, 0] }))
  await app.idle()
  await app.tab('Print')

  // pair, then add the PrusaLink printer from discovery (its password is filled in for the simulated one)
  await app.ribbon('Printers').click()
  await expect(page.getByTestId('pair-input')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('pair-input').fill(pairingCode())
  await expect(page.getByTestId('printers-panel')).toHaveAttribute('data-conn', 'ready', { timeout: 20_000 })
  await page.getByTestId('printers-add').click()
  await page.getByTestId('discover-go').click()
  await page.locator("[data-testid='found-printer'][data-kind='prusa'][data-name='Simulated Prusa MK4S']").click({ timeout: 30_000 })
  await expect(page.getByTestId('add-form')).toHaveAttribute('data-kind', 'prusa')
  await expect(page.getByTestId('add-password')).not.toHaveValue('')
  await page.getByTestId('add-go').click()
  const card = page.locator("[data-testid='printer-card'][data-kind='prusa']")
  await expect(card).toHaveAttribute('data-online', 'true', { timeout: 30_000 })
  await expect(card.getByTestId('printer-extras')).toContainText('Print fan')
  await page.getByTestId('printers-close').click()

  // slice a cube for the MK4S: the printer is picked in the Print sidebar
  const side = page.getByTestId('print-sidebar')
  await side.getByTestId('printer-picker').click()
  await page.getByPlaceholder('Search printers').fill('MK4S')
  await page.getByTestId('printer-list').getByRole('button', { name: 'Prusa MK4S', exact: true }).click()
  await expect(side.getByTestId('preset-process')).toContainText('MK4S', { timeout: 30_000 })
  await expect(side.getByTestId('plate-size')).toContainText('250 x 210')
  await page.getByTestId('slice-plate').click()
  await expect(page.getByTestId('slice-card')).toHaveAttribute('data-status', 'done', { timeout: 150_000 })

  // send: only the PrusaLink printer is offered for a Prusa machine, with its storage; the file goes as plain G-code
  await page.getByTestId('send-to-printer').click()
  await expect(page.getByTestId('send-dialog')).toBeVisible()
  await expect(page.getByTestId('send-printer')).toContainText('PrusaLink')
  await expect(page.getByTestId('send-printer').locator('option')).toHaveCount(1)
  await expect(page.getByTestId('send-storage')).toHaveValue('/usb', { timeout: 30_000 })
  await expect(page.getByTestId('send-go')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('send-go').click()
  await expect(page.getByTestId('send-progress')).toHaveAttribute('data-stage', 'done', { timeout: 90_000 })
  await page.getByTestId('send-view').click()

  // the job shows in the card, with what PrusaLink reports
  await expect(card).toHaveAttribute('data-state', /running|finish/, { timeout: 30_000 })
  await expect.poll(async () => Number(await card.getAttribute('data-percent')), { timeout: 60_000 }).toBeGreaterThan(0)
  await expect(card.getByTestId('printer-file')).toContainText('.gcode')
  await app.shot('printer-link-prusa-printing')
})

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return
  console.log('HELPER OUTPUT\n' + out)
  console.log('LINK STORE ' + JSON.stringify(await page.evaluate(() => { const l = (window as any).__caddy?.link?.getState(); return l && { conn: l.conn, statuses: l.statuses, printers: l.printers } }))) // eslint-disable-line
})
