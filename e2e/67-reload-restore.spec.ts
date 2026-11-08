import { test, expect, type App } from './helpers'
import type { Page } from '@playwright/test'

/**
 * Reload (F5, Ctrl+R, the update button) brings the tab back exactly as it was: the model, the timeline and its rollback marker, undo,
 * the unsaved dot, the file it saves to, the camera, the workspace, the selection, the sketch or feature dialog that was open. Nothing
 * asks about it. The tab id lives in sessionStorage, so a tab with no snapshot (a new tab, a copy of a tab, a browser restart) still
 * meets the crash-recovery prompt.
 *
 * The fixture switches the snapshot off for every other spec (they reload pages and expect a blank start); these opt back in.
 */

/** Installed before every page load: opts in, and notes when the model first shows (marks are ms since the navigation started). */
async function optIn(page: Page) {
  await page.addInitScript(() => {
    const w = window as any // eslint-disable-line
    w.__e2eSession = true
    w.__e2eNoAutosave = false // the crash-recovery prompt is live, so "no prompt" below means something
    try { if (!localStorage.getItem('caddy.settings')) localStorage.setItem('caddy.settings', JSON.stringify({ tourSeen: true })) } catch { /* none */ }
    w.__marks = {}
    const t = setInterval(() => {
      const c = w.__caddy
      if (!c) return
      const s = c.doc.getState()
      const m = w.__marks
      const now = performance.now()
      if (!m.caddy) m.caddy = now
      if (s.features.length && !m.features) m.features = now
      if (s.ghost && !m.ghost) { m.ghost = now; m.ghostBodies = s.ghost.map((b: any) => [b.id, b.mesh.indices.length / 3]) }
      if (s.geometry.length && !m.geometry) m.geometry = now
      if (s.features.length && !s.regenerating && s.geometry.length && !m.done) { m.done = now; clearInterval(t) }
    }, 4)
  })
}

const marks = (page: Page) => page.evaluate(() => (window as any).__marks as Record<string, any>) // eslint-disable-line

async function reload(page: Page) {
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__caddy?.three) // eslint-disable-line
}

/** A 30 x 20 x 10 block (sketch + extrude) with one filleted edge: three features, three undo steps. */
async function build(app: App) {
  await app.open()
  await app.sketchRect('XY', 30, 20)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  await app.field('Distance', '10')
  await app.ok()
  const body = (await app.bodies()).find((b) => b.kind === 'brep')!
  await app.ev((c, id) => { c.ui.getState().setSelection([{ kind: 'edge', id, index: 0 }]); c.runCommand('solid.fillet') }, body.id)
  await expect(app.inspector().locator('.panel-title')).toHaveText('Fillet')
  await app.field('Radius', '2')
  await app.ok()
  expect((await app.features()).map((f) => f.type)).toEqual(['sketch', 'extrude', 'fillet'])
}

const camera = (app: App) => app.page.evaluate(() => (window as any).__caddy.three.camera.matrixWorld.elements as number[]) // eslint-disable-line
const rows = (app: App) => app.page.locator('.tl .chip').allInnerTexts()

test('reload puts the tab back exactly: timeline, camera, workspace, dirty, undo, selection, the open feature dialog', async ({ app, page }) => {
  test.setTimeout(150_000)
  await optIn(page)
  await build(app)
  await app.tab('Mesh')
  // somewhere other than the home view
  await app.ev((c) => { c.bus.emit('orbit', { dx: 140, dy: -60 }); c.bus.emit('view', 'right'); c.bus.emit('orbit', { dx: -30, dy: 25 }) })
  await app.cameraStable()
  const body = (await app.bodies()).find((b) => b.kind === 'brep')!
  await app.ev((c, id) => { c.ui.getState().setSelection([{ kind: 'face', id, index: 1 }]); c.doc.setState({ name: 'Bracket' }) }, body.id)
  // a file to save to (the origin private file system hands out a real handle, which IndexedDB can keep like the picker's)
  await page.evaluate(async () => {
    const h = await (await navigator.storage.getDirectory()).getFileHandle('reload-e2e.caddy', { create: true });
    (window as any).__caddy.session.setCurrentFile(h) // eslint-disable-line
  })
  const chips = page.locator('.tl .chip')
  await expect(chips).toHaveCount(3)
  const before = await rows(app)
  const state = await app.ev((c) => {
    const d = c.doc.getState()
    return { dirty: d.dirty, undo: d.undoDepth, rollback: d.rollback, name: d.name, workspace: c.ui.getState().workspace, projection: c.ui.getState().projection, sel: c.ui.getState().selection }
  })
  expect(state.dirty).toBe(true)
  expect(state.rollback).toBe(3)
  const cam = await camera(app)
  await page.waitForTimeout(700) // the snapshot is written a moment after the last change
  await app.ev((c) => c.session.flush())

  await reload(page)
  // nothing asks about it, and the model is already on screen
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await app.ev((c) => c.recovery.getState().record)).toBeNull()
  expect(await app.ev((c) => c.session.restored())).toBe(true)
  const m = await marks(page)
  console.log('reload marks (ms since navigation):', JSON.stringify(m))
  expect(m.ghostBodies, 'the bodies kept from before show before the kernel has made them again').toBeTruthy()
  // restoring is quick: from the page being up to the model being on screen (the rest is loading the app, which a reload always does)
  expect(m.features - m.caddy).toBeLessThan(1500)
  expect(m.ghost - m.caddy).toBeLessThan(1500)
  await app.idle()
  // what was shown first is what the kernel makes
  const real = await app.bodies()
  expect(m.ghostBodies.map((b: [string, number]) => [b[0], b[1]])).toEqual(real.map((b) => [b.id, b.tris]))

  expect(await rows(app)).toEqual(before)
  expect(await app.ev((c) => c.doc.getState().rollback)).toBe(3)
  expect(await app.ev((c) => c.ui.getState().inspector)).toBeNull()
  // the view, the tab, the selection, the name, the unsaved dot
  const camAfter = await camera(app)
  camAfter.forEach((v, i) => expect(Math.abs(v - cam[i])).toBeLessThan(1e-3))
  await expect(page.locator('.ribbon-tabs').getByRole('tab', { name: 'Mesh' })).toHaveAttribute('aria-selected', 'true')
  const after = await app.ev((c) => {
    const d = c.doc.getState()
    return { dirty: d.dirty, undo: d.undoDepth, name: d.name, workspace: c.ui.getState().workspace, projection: c.ui.getState().projection, sel: c.ui.getState().selection }
  })
  expect(after).toEqual({ dirty: true, undo: state.undo, name: 'Bracket', workspace: state.workspace, projection: state.projection, sel: state.sel })
  expect(await app.ev((c) => c.session.currentFile()?.name)).toBe('reload-e2e.caddy')

  // undo still has every step
  await app.ev((c) => c.doc.getState().undo())
  await app.idle()
  expect((await app.features()).map((f) => f.type)).toEqual(['sketch', 'extrude'])
  await app.ev((c) => c.doc.getState().redo())
  await app.idle()
  expect((await app.features()).map((f) => f.type)).toEqual(['sketch', 'extrude', 'fillet'])

  // Ctrl+S goes to the same file without asking, and cleans the project
  await app.ev(async (c) => { await c.saveDocument() })
  expect(await app.ev((c) => c.doc.getState().dirty)).toBe(false)
  const size = await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('reload-e2e.caddy')).getFile()).size)
  expect(size).toBeGreaterThan(500)
  await page.evaluate(async () => { await (await navigator.storage.getDirectory()).removeEntry('reload-e2e.caddy').catch(() => {}) })

  // a feature dialog that is half filled in: the timeline sits before the feature while it is open
  await app.ev(async (c) => { await c.flushAutosave() })
  await chips.nth(1).dblclick()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  await app.field('Distance', '25')
  expect(await app.ev((c) => c.doc.getState().rollback)).toBe(1)
  await page.waitForTimeout(700)
  await app.ev((c) => c.session.flush())
  await reload(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  expect(await app.ev((c) => c.ui.getState().inspector.latest?.distance ?? c.ui.getState().inspector.values.distance)).toBe(25)
  expect(await app.ev((c) => c.doc.getState().rollback)).toBe(1)
  expect(await rows(app)).toEqual(before)
  // cancelling puts the marker back where it was, and the edit that was never accepted is not in the document
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  await app.idle()
  expect(await app.ev((c) => c.doc.getState().rollback)).toBe(3)
  expect((await app.features()).map((f) => f.state)).toEqual(['ok', 'ok', 'ok'])
  expect((await app.features())[1].params.distance).toBe(10)
  expect(await app.ev((c) => [c.doc.getState().dirty, c.doc.getState().name])).toEqual([false, 'reload-e2e'])
})

test('a sketch that is being edited is open again after a reload, with the view where it was', async ({ app, page }) => {
  test.setTimeout(150_000)
  await optIn(page)
  await build(app)
  await page.locator('.tl .chip').nth(0).dblclick()
  await expect(page.locator('.sk-bar')).toBeVisible()
  const sk = await app.ev((c) => { const s = c.sketch.getState(); return { editing: s.editing, entities: s.model.entities.length, profiles: s.profiles.length } })
  expect(sk.editing).toBe('f1')
  await app.cameraStable()
  const cam = await camera(app)
  await page.waitForTimeout(700)
  await app.ev((c) => c.session.flush())

  await reload(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.sk-bar')).toBeVisible()
  await expect(page.locator('.ribbon-tabs').getByRole('tab', { name: /sketch/i })).toHaveAttribute('aria-selected', 'true')
  expect(await app.ev((c) => { const s = c.sketch.getState(); return { editing: s.editing, entities: s.model.entities.length, profiles: s.profiles.length } })).toEqual(sk)
  const camAfter = await camera(app)
  camAfter.forEach((v, i) => expect(Math.abs(v - cam[i])).toBeLessThan(1e-3))
  // the timeline sits before the sketch while it is open, and finishing puts everything back
  expect(await app.ev((c) => c.doc.getState().rollback)).toBe(0)
  await app.finishSketch()
  expect(await app.ev((c) => c.doc.getState().rollback)).toBe(3)
  expect((await app.features()).map((f) => f.state)).toEqual(['ok', 'ok', 'ok'])
})

test('bodies kept from before are never shown for a document that changed since', async ({ app, page }) => {
  test.setTimeout(150_000)
  await optIn(page)
  await build(app)
  await page.waitForTimeout(700)
  await app.ev((c) => c.session.flush()) // the bodies of the 10 mm block are kept
  // an edit, snapshotted while the kernel is still making the new bodies
  await app.ev((c) => {
    const f = c.doc.getState().features[1]
    c.doc.getState().updateFeature(f.id, { ...f.params, distance: 33 })
    return c.session.flush()
  })
  await reload(page)
  await app.idle()
  const m = await marks(page)
  expect(m.ghost, 'the 10 mm bodies must not show for the 33 mm document').toBeUndefined()
  const bb = await app.bbox((await app.bodies())[0].id)
  expect(bb.max[2] - bb.min[2]).toBeCloseTo(33, 3)
})

test('a tab with no snapshot still meets the recovery prompt: a new tab, and a copy of a tab', async ({ app, page, context }) => {
  test.setTimeout(150_000)
  await optIn(page)
  await build(app)
  await app.ev(async (c) => { await c.flushAutosave() }) // the crash copy a dirty project leaves behind
  const tab = await app.ev((c) => c.session.tab())
  expect(tab).toBeTruthy()
  await app.ev((c) => c.session.flush())

  // this tab reloads: its snapshot wins, the crash copy is not offered
  await reload(page)
  await app.idle()
  await page.waitForTimeout(1500)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await app.ev((c) => c.doc.getState().features.length)).toBe(3)

  // a new tab: no tab id, so nothing to restore, and the crash copy is offered as before
  const second = await context.newPage()
  await second.addInitScript(() => {
    const w = window as any // eslint-disable-line
    w.__e2eSession = true
    w.__e2eNoAutosave = false
    w.__e2eNoTour = true
    try { localStorage.setItem('caddy.settings', JSON.stringify({ tourSeen: true })) } catch { /* none */ }
  })
  await second.goto('/')
  await second.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
  await expect(second.getByRole('dialog')).toContainText('Recover unsaved work?')
  expect(await second.evaluate(() => (window as any).__caddy.session.restored())).toBe(false) // eslint-disable-line
  await second.close()

  // a duplicated tab carries the same sessionStorage, but the first tab still holds its id: it is a new tab too
  const copy = await context.newPage()
  await copy.addInitScript((id) => {
    const w = window as any // eslint-disable-line
    w.__e2eSession = true
    w.__e2eNoAutosave = false
    w.__e2eNoTour = true
    try { sessionStorage.setItem('caddy-tab', id); localStorage.setItem('caddy.settings', JSON.stringify({ tourSeen: true })) } catch { /* none */ }
  }, tab as string)
  await copy.goto('/')
  await copy.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
  await expect(copy.getByRole('dialog')).toContainText('Recover unsaved work?')
  expect(await copy.evaluate(() => (window as any).__caddy.session.restored())).toBe(false) // eslint-disable-line
  expect(await copy.evaluate(() => (window as any).__caddy.session.tab())).not.toBe(tab)
  await copy.close()
})

test('a new sketch that is not finished yet comes back, and finishing it still adds the feature', async ({ app, page }) => {
  test.setTimeout(120_000)
  await optIn(page)
  await app.open()
  await app.sketchRect('XY', 30, 20)
  await page.waitForTimeout(700)
  await app.ev((c) => c.session.flush())
  await reload(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.sk-bar')).toBeVisible()
  expect(await app.ev((c) => { const s = c.sketch.getState(); return [s.active, s.editing, s.profiles.length, c.doc.getState().features.length] })).toEqual([true, null, 1, 0])
  await app.finishSketch()
  expect((await app.features()).map((f) => [f.type, f.state])).toEqual([['sketch', 'ok']])
})

test('a new feature dialog comes back with what was typed, and OK still makes the feature', async ({ app, page }) => {
  test.setTimeout(120_000)
  await optIn(page)
  await app.open()
  await app.sketchRect('XY', 30, 20)
  await app.finishSketch()
  await app.ribbon('Extrude').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  await app.field('Distance', '7')
  await page.waitForTimeout(700)
  await app.ev((c) => c.session.flush())
  await reload(page)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  expect(await app.ev((c) => c.ui.getState().inspector.latest?.distance ?? c.ui.getState().inspector.values.distance)).toBe(7)
  await app.ok()
  const f = await app.features()
  expect(f.map((x) => [x.type, x.state])).toEqual([['sketch', 'ok'], ['extrude', 'ok']])
  expect(f[1].params.distance).toBe(7)
  const bb = await app.bbox()
  expect(bb.max[2] - bb.min[2]).toBeCloseTo(7, 3)
})
