/** Helpers shared by the drawing specs. */
import { expect, addSketch, XY, type App } from './helpers'

/** A 40 x 30 x 10 plate with a 8 mm hole through the middle, made from a sketch and an extrude. */
export async function plate(app: App, w = 40) {
  const sk = await addSketch(app, XY, [
    { k: 'rect', x0: -w / 2, y0: -15, x1: w / 2, y1: 15 },
    { k: 'circle', c: [0, 0], r: 4 },
  ])
  // the extrude dialog lists the profiles of the sketch: the first is the plate with the hole cut out of it
  await app.ev((c, id) => { c.ui.getState().setSelection([{ kind: 'sketch', id }]); c.runCommand('solid.extrude') }, sk)
  await expect(app.inspector().locator('.panel-title')).toHaveText('Extrude')
  const profiles: string[] = await app.ev((c) => c.ui.getState().inspector.values.profiles)
  await app.ev((c) => c.ui.getState().inspector.onCancel())
  await app.ev((c, p) => c.doc.getState().addFeature('extrude', { profiles: [p], direction: 'one', distance: 10, distance2: 5, taper: 0, operation: 'new', targets: [] }), profiles[0])
  await app.idle()
  const f = await app.features()
  expect(f.map((x) => x.state), JSON.stringify(f.map((x) => x.error))).toEqual(f.map(() => 'ok'))
}

export async function drawing(app: App) {
  await app.tab('Drawing')
  await expect(app.page.getByTestId('drawing-workspace')).toBeVisible()
}

/** Wait until every view of every sheet has its geometry. */
export async function geomReady(app: App) {
  await expect.poll(() => app.ev((c) => {
    const d = c.drawing.store.getState().doc
    const g = c.drawing.geoms.getState().geoms
    return d.sheets.every((s: any) => s.views.every((v: any) => !!g[s.id + '/' + v.id])) // eslint-disable-line
  })).toBe(true)
  await app.page.waitForTimeout(150)
}

/** Make a base view through the ribbon and the dialog. */
export async function addBaseView(app: App, orientation = 'Front', opts: { ribbon?: string } = {}) {
  const before = await app.ev((c) => c.drawing.store.getState().doc.sheets[0]?.views.length ?? 0)
  await app.ribbon(opts.ribbon ?? 'Base View').click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Base view')
  if (orientation !== 'Front') {
    await app.inspector().locator('.field', { has: app.page.locator('.field-label', { hasText: 'Orientation' }) }).locator('button.sel').click()
    await app.page.getByRole('option', { name: orientation, exact: true }).click()
  }
  await app.ok()
  await expect.poll(() => app.ev((c) => c.drawing.store.getState().doc.sheets[0]?.views.length ?? 0)).toBe(before + 1)
  await geomReady(app)
}

/** Client pixel of a point on the sheet (mm, y up). */
export async function px(app: App, x: number, y: number): Promise<{ x: number; y: number }> {
  return app.page.evaluate(([x, y]) => {
    const svg = document.querySelector('[data-testid=drawing-svg]') as SVGSVGElement
    const vb = svg.viewBox.baseVal
    const r = svg.getBoundingClientRect()
    const H = Number(svg.dataset.h)
    return { x: r.left + ((x - vb.x) / vb.width) * r.width, y: r.top + ((H - y - vb.y) / vb.height) * r.height }
  }, [x, y] as [number, number])
}

export async function click(app: App, x: number, y: number, opts: { move?: boolean } = {}) {
  const p = await px(app, x, y)
  await app.page.mouse.move(p.x, p.y, { steps: 2 })
  await app.page.mouse.click(p.x, p.y)
}
export async function hover(app: App, x: number, y: number) {
  const p = await px(app, x, y)
  await app.page.mouse.move(p.x, p.y, { steps: 2 })
}

export const sheet = (app: App) => app.ev((c) => c.drawing.store.getState().doc.sheets[0])
export const viewOf = async (app: App, id: string) => (await sheet(app)).views.find((v: any) => v.id === id) // eslint-disable-line

/** Sheet position of a view's center of bounds, from its geometry. */
export async function viewCenter(app: App, id: string): Promise<[number, number]> {
  return app.ev((c, id) => {
    const s = c.drawing.store.getState().doc.sheets[0]
    const v = s.views.find((x: any) => x.id === id) // eslint-disable-line
    return [v.pos[0], v.pos[1]]
  }, id)
}

/** Sheet rectangle of a view, from its geometry. */
export async function viewBox(app: App, id: string): Promise<[number, number, number, number]> {
  return app.ev((c, id) => {
    const s = c.drawing.store.getState().doc.sheets[0]
    const v = s.views.find((x: any) => x.id === id) // eslint-disable-line
    const g = c.drawing.geoms.getState().geoms[s.id + '/' + id]
    const a = [v.pos[0] + (g.bounds[0] - v.anchor[0]) * v.scale, v.pos[1] + (g.bounds[1] - v.anchor[1]) * v.scale]
    const b = [v.pos[0] + (g.bounds[2] - v.anchor[0]) * v.scale, v.pos[1] + (g.bounds[3] - v.anchor[1]) * v.scale]
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
  }, id)
}

export const primsOf = (app: App) => app.ev(async (c) => {
  const s = c.drawing.store.getState().doc.sheets[0]
  const o = await c.drawing.sheetOutput(s)
  return o.prims.map((p: any) => ({ k: p.k, style: p.style, owner: p.owner, text: p.text, n: p.pts ? p.pts.length / 2 : 0, fill: p.fill, pick: p.pick })) // eslint-disable-line
}) as Promise<{ k: string; style?: string; owner?: string; text?: string; n: number; fill?: string; pick?: boolean }[]>

export const tool = (app: App) => app.ev((c) => c.drawing.tool.getState().tool)

/** Zoom the sheet to a rectangle (mm) so a screenshot shows the drawing at a readable size. */
export async function zoomTo(app: App, x0: number, y0: number, x1: number, y1: number) {
  await app.ev((c, r) => c.drawing.camera.current.zoomRect(r[0], r[1], r[2], r[3]), [x0, y0, x1, y1])
  await app.page.waitForTimeout(250)
}

/** Zoom the sheet to a view, with some room around it for its dimensions. */
export async function zoomView(app: App, id: string, pad = 30) {
  const b = await viewBox(app, id)
  await zoomTo(app, b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad)
}
