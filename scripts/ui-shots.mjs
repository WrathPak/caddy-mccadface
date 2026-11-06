// Screenshot tour of the UI for design review. Usage: node scripts/ui-shots.mjs [baseUrl] [outDir] [prefix]
import { chromium } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'

const base = process.argv[2] ?? 'http://localhost:5173'
const out = path.resolve(process.argv[3] ?? 'docs/ui-revamp')
const prefix = process.argv[4] ?? ''
fs.mkdirSync(out, { recursive: true })

// the real GPU by default (the glass and the lighting are made for it); GPU=0 uses software WebGL like the e2e runs
const browser = await chromium.launch({ args: process.env.GPU === '0' ? ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] })

async function open(vp, opts = {}) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, hasTouch: !!opts.touch, isMobile: !!opts.touch })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('pageerror', e.message))
  page.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text()))
  await page.addInitScript(() => { window.__e2eNoAutosave = true; window.__e2eNoTour = true })
  await page.goto(base + (process.env.GLASS === 'off' ? '/?glass=off' : '/?glass=auto'))
  await page.waitForFunction(() => !!window.__caddy)
  await page.waitForTimeout(1200)
  return { ctx, page }
}
const ev = (page, fn, arg) => page.evaluate(`(async () => (${fn.toString()})(window.__caddy, ${JSON.stringify(arg ?? null)}))()`)
const idle = async (page) => { await page.waitForFunction(() => !window.__caddy.doc.getState().regenerating); await page.waitForTimeout(400) }
const shot = async (page, name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, `${prefix}${name}.png`) }); console.log('shot', name) }

function sketchJson() {
  const pts = [[-20, -12], [20, -12], [20, 12], [-20, 12]]
  const ents = pts.map((p, i) => ({ id: 'p' + (i + 1), type: 'point', x: p[0], y: p[1] }))
  for (let i = 0; i < 4; i++) ents.push({ id: 'l' + (i + 5), type: 'line', p1: 'p' + (i + 1), p2: 'p' + (((i + 1) % 4) + 1) })
  return JSON.stringify({ plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, face: null, model: { entities: ents, constraints: [], next: 20 } })
}

async function body(page) {
  // a plate with a hole and a second, smaller block, so the glass has something to blur
  const id = await ev(page, (c, s) => c.doc.getState().addFeature('sketch', { sketch: s }), sketchJson())
  await idle(page)
  await ev(page, (c, id) => { c.ui.getState().setSelection([{ kind: 'sketch', id }]); c.runCommand('solid.extrude') }, id)
  await page.waitForTimeout(600)
  const profiles = await ev(page, (c) => c.ui.getState().inspector.values.profiles)
  await ev(page, (c) => c.ui.getState().inspector.onCancel())
  await ev(page, (c, p) => c.doc.getState().addFeature('extrude', { profiles: [p], direction: 'one', distance: 14, distance2: 5, taper: 0, operation: 'new', targets: [] }), profiles[0])
  await idle(page)
  await ev(page, (c) => { c.ui.getState().clearSelection(); c.runCommand('view.home'); c.runCommand('view.frame') })
  await page.waitForTimeout(1200)
}

const sizes = [['1440', { width: 1440, height: 900 }], ['1000', { width: 1000, height: 700 }]]
const only = process.env.ONLY?.split(',')
const want = (n) => !only || only.includes(n)

async function sketchScene(page) {
  await page.locator('.ribbon-body').getByRole('button', { name: 'Sketch' }).first().click()
  await page.waitForTimeout(500)
  await page.getByText('XY plane').click()
  await page.waitForTimeout(900)
  await page.locator('.ribbon-body').getByRole('button', { name: 'Rectangle' }).first().click()
  const b = await page.locator('.vp canvas').boundingBox()
  const cx = b.x + b.width * 0.5, cy = b.y + b.height * 0.55
  await page.mouse.move(cx, cy); await page.mouse.click(cx, cy)
  await page.mouse.move(cx + 120, cy - 80, { steps: 3 })
  await page.keyboard.type('30'); await page.keyboard.press('Tab'); await page.keyboard.type('20'); await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  await page.locator('.ribbon-body').getByRole('button', { name: 'Circle' }).first().click().catch(() => {})
  await page.waitForTimeout(300)
}

for (const [tag, vp] of sizes) {
  if (!want(tag)) continue
  for (const theme of ['dark', 'light']) {
    const setTheme = async (page) => { if (theme === 'light') { await page.evaluate(() => window.__caddy.ui.getState().setTheme('light')); await page.waitForTimeout(300) } }
    // 1. empty, then a body
    let { ctx, page } = await open(vp)
    await setTheme(page)
    await shot(page, `${tag}-${theme}-empty`)
    await body(page)
    await shot(page, `${tag}-${theme}-body`)
    // body selected, its extrude open in the inspector
    await page.locator('.tl .chip').last().click().catch(() => {})
    await page.locator('.tl .chip').last().dblclick().catch(() => {})
    await page.waitForTimeout(900)
    await shot(page, `${tag}-${theme}-inspector`)
    await page.locator('.inspector-foot').getByRole('button', { name: 'Cancel' }).click().catch(() => {})
    await page.waitForTimeout(300)
    await page.locator('.tree-row', { hasText: 'Extrude1' }).first().click().catch(() => {})
    await shot(page, `${tag}-${theme}-selected`)
    await page.getByRole('button', { name: 'Box options' }).click().catch(() => {})
    await shot(page, `${tag}-${theme}-menu`)
    await page.keyboard.press('Escape')
    await page.locator('.vp canvas').focus().catch(() => {}); await page.keyboard.press('s')
    await page.waitForTimeout(300)
    await shot(page, `${tag}-${theme}-palette`)
    await page.keyboard.press('Escape')
    await ctx.close()
    // 2. sketch mode
    ;({ ctx, page } = await open(vp))
    await setTheme(page)
    await sketchScene(page)
    await shot(page, `${tag}-${theme}-sketch`)
    await ctx.close()
  }
}

if (want('extras')) {
  for (const theme of ['dark', 'light']) {
    const { ctx, page } = await open({ width: 1440, height: 900 })
    if (theme === 'light') { await page.evaluate(() => window.__caddy.ui.getState().setTheme('light')); await page.waitForTimeout(300) }
    await body(page)
    // History panel as a tab beside the Browser, a tree context menu, the marking menu, settings and help
    await page.getByRole('button', { name: 'Panels' }).click()
    await page.getByRole('menuitem', { name: 'History' }).click()
    await page.waitForTimeout(700)
    await shot(page, `extra-${theme}-history-tab`)
    await page.getByRole('tab', { name: 'Browser' }).click().catch(() => {})
    await page.locator('.tree-row', { hasText: 'Extrude1' }).first().click({ button: 'right' }).catch(() => {})
    await shot(page, `extra-${theme}-context-menu`)
    await page.keyboard.press('Escape')
    const b = await page.locator('.vp-hole').boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.down({ button: 'right' }); await page.waitForTimeout(500)
    await shot(page, `extra-${theme}-marking-menu`)
    await page.mouse.up({ button: 'right' }); await page.keyboard.press('Escape')
    await page.getByTestId('settings-gear').click().catch(() => {})
    await page.waitForTimeout(500)
    await shot(page, `extra-${theme}-settings`)
    await page.keyboard.press('Escape')
    await page.getByTestId('help-menu').click()
    await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click()
    await page.waitForTimeout(500)
    await shot(page, `extra-${theme}-help`)
    await ctx.close()
  }
}

if (want('phone')) {
  for (const theme of ['dark', 'light']) {
    const { ctx, page } = await open({ width: 390, height: 844 }, { touch: true })
    if (theme === 'light') { await page.evaluate(() => window.__caddy.ui.getState().setTheme('light')); await page.waitForTimeout(300) }
    await shot(page, `phone-${theme}-empty`)
    await body(page)
    await shot(page, `phone-${theme}-body`)
    await ev(page, (c) => { c.runCommand('solid.fillet') })
    await page.waitForTimeout(900)
    await shot(page, `phone-${theme}-inspector`)
    await ev(page, (c) => c.ui.getState().inspector?.onCancel())
    await page.getByTestId('m-browser').tap().catch(() => {})
    await page.waitForTimeout(500)
    await shot(page, `phone-${theme}-browser`)
    await page.getByTestId('m-close-left').tap().catch(() => {})
    await page.getByRole('button', { name: 'Sketch' }).first().tap().catch(() => {})
    await page.waitForTimeout(500)
    await shot(page, `phone-${theme}-planepick`)
    await page.getByTestId('m-plane-XY').tap().catch(() => {})
    await page.waitForTimeout(900)
    await shot(page, `phone-${theme}-sketch`)
    await ctx.close()
  }
}
await browser.close()
