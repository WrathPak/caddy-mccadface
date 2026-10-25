import { test as base, expect, type Page } from '@playwright/test'
import path from 'node:path'

export { expect }
export const SHOTS = path.resolve(import.meta.dirname, 'screenshots')

/** Every spec runs with: console.error / pageerror / external requests => test failure. */
export const test = base.extend<{ app: App }>({
  app: async ({ page }, use) => {
    // CPU_THROTTLE=4 reproduces a slow CI runner locally
    if (process.env.CPU_THROTTLE) {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU_THROTTLE) })
    }
    const problems: string[] = []
    const external: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console.error: ${m.text()}`)
    })
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (!['localhost', '127.0.0.1', ''].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) external.push(r.url())
    })
    // force the download fallback for project saves / opens; no autosave or recovery prompt can carry over between page loads of a test
    await page.addInitScript(() => {
      ;(window as unknown as Record<string, unknown>).__e2eNoAutosave = true
      delete (window as unknown as Record<string, unknown>).showSaveFilePicker
      delete (window as unknown as Record<string, unknown>).showOpenFilePicker
    })
    const app = new App(page)
    await use(app)
    const left = problems.filter((p) => !app.allowed.some((re) => re.test(p)))
    expect(left, 'console errors / page errors').toEqual([])
    expect(external, 'external network requests').toEqual([])
  },
})

export class App {
  /** console errors a spec expects (e.g. a deliberately crashed panel) */
  allowed: RegExp[] = []
  constructor(public page: Page) {}
  allow(re: RegExp) { this.allowed.push(re) }

  async open() {
    // E2E_CPU_THROTTLE=4 runs the page on a 4x slower CPU, like a busy CI runner
    const slow = Number(process.env.E2E_CPU_THROTTLE ?? 1)
    if (slow > 1) await (await this.page.context().newCDPSession(this.page)).send('Emulation.setCPUThrottlingRate', { rate: slow })
    await this.page.goto('/')
    await this.page.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
    await expect(this.page.locator('canvas').first()).toBeVisible()
    // let the kernel worker spin up
    await this.page.waitForTimeout(500)
  }

  /** Run `fn` in the page with the debug handle. */
  ev<T, A = undefined>(fn: (c: any, arg: A) => T | Promise<T>, arg?: A): Promise<T> { // eslint-disable-line
    return this.page.evaluate(`(async () => (${fn.toString()})(window.__caddy, ${JSON.stringify(arg ?? null)}))()`) as Promise<T>
  }

  async shot(name: string) {
    await this.page.waitForTimeout(250)
    await this.page.screenshot({ path: path.join(SHOTS, name + '.png') })
  }

  async idle() {
    await this.page.waitForFunction(() => {
      const c = (window as any).__caddy // eslint-disable-line
      return !!c && !c.doc.getState().regenerating
    })
    await this.page.waitForTimeout(150)
  }

  async tris() {
    return this.ev((c) => c.ui.getState().triangles)
  }

  async features(): Promise<{ id: string; type: string; name: string; state: string; error?: string; params: any }[]> { // eslint-disable-line
    return this.ev((c) => c.doc.getState().features.map((f: any) => ({ id: f.id, type: f.type, name: f.name, state: f.state, error: f.error, params: f.params }))) // eslint-disable-line
  }

  async bodies(): Promise<{ id: string; name: string; kind: string; tris: number }[]> {
    return this.ev((c) => c.doc.getState().geometry.map((b: any) => ({ id: b.id, name: b.name, kind: b.kind, tris: b.mesh.indices.length / 3 }))) // eslint-disable-line
  }

  /** Wait until the camera stops moving (view transitions animate). */
  async cameraStable() {
    await this.page.waitForFunction(() => !!(window as any).__caddy?.three) // eslint-disable-line
    // software WebGL can take over a hundred milliseconds per frame, so one unchanged reading proves nothing: require several
    const read = () => this.page.evaluate(() => JSON.stringify((window as any).__caddy.three.camera.matrixWorld.elements)) // eslint-disable-line
    // run the camera's animation to its end on stepped time, so a slow frame rate can't leave it half way
    await this.page.evaluate(() => (window as any).__caddy.nav.settle()) // eslint-disable-line
    let prev = await read()
    let same = 0
    for (let i = 0; i < 80 && same < 3; i++) {
      await this.page.waitForTimeout(150)
      const cur = await read()
      same = cur === prev ? same + 1 : 0
      prev = cur
    }
  }

  /** Client-space pixel of a world point (needs the dev camera probe). */
  async project(x: number, y: number, z: number): Promise<{ x: number; y: number }> {
    await this.cameraStable()
    return this.page.evaluate(([x, y, z]) => {
      const t = (window as any).__caddy.three // eslint-disable-line
      const cam = t.camera
      cam.updateMatrixWorld()
      const V = cam.matrixWorldInverse.elements, P = cam.projectionMatrix.elements
      const mul = (m: number[], v: number[]) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3])
      const c = mul(P, mul(V, [x, y, z, 1]))
      const r = document.querySelector('.vp canvas')!.getBoundingClientRect()
      return { x: r.left + ((c[0] / c[3] + 1) / 2) * r.width, y: r.top + ((1 - c[1] / c[3]) / 2) * r.height }
    }, [x, y, z] as [number, number, number])
  }

  async bbox(id?: string): Promise<{ min: number[]; max: number[] }> {
    return this.ev((c, id) => {
      const bs = c.doc.getState().geometry
      const b = id ? bs.find((x: any) => x.id === id) : bs[0] // eslint-disable-line
      const p = b.mesh.positions
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]) }
      return { min, max }
    }, id)
  }

  /** Draw a w x h rectangle (typed dims) on an origin plane and finish the sketch. */
  async sketchRect(plane: 'XY' | 'XZ' | 'YZ', w: number, h: number, at = { x: 500, y: 400 }) {
    const { page } = this
    await this.ribbon('Sketch').first().click()
    const planes = page.getByText('Planes', { exact: true })
    if (!(await page.getByText(plane + ' plane').isVisible())) await planes.click()
    await page.getByText(plane + ' plane').click()
    await expect(page.locator('.sk-bar')).toBeVisible()
    await this.ribbon('Rectangle').first().click()
    const b = (await page.locator('.vp canvas').boundingBox())!
    await page.mouse.move(b.x + at.x, b.y + at.y)
    await page.mouse.click(b.x + at.x, b.y + at.y)
    await page.mouse.move(b.x + at.x + 80, b.y + at.y - 60, { steps: 3 })
    await page.keyboard.type(String(w))
    await page.keyboard.press('Tab')
    await page.keyboard.type(String(h))
    await page.keyboard.press('Enter')
    await expect.poll(() => this.ev((c) => c.sketch.getState().profiles.length)).toBe(1)
    await page.keyboard.press('Escape') // leave the rectangle tool
  }
  async finishSketch() {
    await this.ribbon('Finish Sketch').click()
    await this.idle()
    await expect(this.page.locator('.sk-bar')).toBeHidden()
  }

  /** Enclosed volume of a body mesh (signed tetrahedra sum). */
  async volume(id?: string): Promise<number> {
    return this.ev((c, id) => {
      const bs = c.doc.getState().geometry
      const b = id ? bs.find((x: any) => x.id === id) : bs[0] // eslint-disable-line
      const p = b.mesh.positions, ix = b.mesh.indices
      let v = 0
      for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, bb = ix[t + 1] * 3, cc = ix[t + 2] * 3
        v += (p[a] * (p[bb + 1] * p[cc + 2] - p[bb + 2] * p[cc + 1]) - p[a + 1] * (p[bb] * p[cc + 2] - p[bb + 2] * p[cc]) + p[a + 2] * (p[bb] * p[cc + 1] - p[bb + 1] * p[cc])) / 6
      }
      return Math.abs(v)
    }, id)
  }

  /** Set one component (0..2) of a vector3 field. */
  async vec(label: string, axis: 0 | 1 | 2, value: string) {
    const f = this.page.locator('.field', { has: this.page.locator('.field-label', { hasText: label }) }).filter({ has: this.page.locator('input') }).first()
    const input = f.locator('input').nth(axis)
    await input.click()
    await input.fill(value)
    await input.press('Tab')
  }

  ribbon(name: string | RegExp) {
    return this.page.locator('.ribbon-body').getByRole('button', { name })
  }
  async tab(name: string) {
    await this.page.locator('.ribbon-tabs').getByRole('tab', { name }).click()
  }
  inspector() {
    return this.page.locator('.panel', { has: this.page.locator('.inspector-foot') })
  }
  async ok() {
    await this.page.locator('.inspector-foot').getByRole('button', { name: 'OK' }).click()
    await this.idle()
  }
  /** Set a labelled field in the Inspector (types the text, Tab commits it (Enter would also accept the dialog)). */
  async field(label: string, value: string) {
    const f = this.page.locator('.field', { has: this.page.locator('.field-label', { hasText: label }) }).filter({ has: this.page.locator('input') }).first()
    const input = f.locator('input').first()
    await input.click()
    await input.fill(value)
    await input.press('Tab')
  }
}

/** Canvas pixel position of a point given in viewport-relative fractions. */
export async function canvasPoint(page: Page, fx: number, fy: number) {
  const b = (await page.locator('.vp canvas').first().boundingBox())!
  return { x: b.x + b.width * fx, y: b.y + b.height * fy }
}

// ---------------------------------------------------------------- programmatic sketches

export type Plane3 = { origin: [number, number, number]; xDir: [number, number, number]; normal: [number, number, number] }
export const XY: Plane3 = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }
/** XZ origin plane: local x = world X, local y = world Z. */
export const XZ: Plane3 = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] }
export type Curve =
  | { k: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { k: 'line'; a: [number, number]; b: [number, number] }
  | { k: 'arc'; c: [number, number]; s: [number, number]; e: [number, number] }
  | { k: 'circle'; c: [number, number]; r: number }

/** JSON for a Sketch feature's `sketch` param (plane + unconstrained curves). */
export function sketchParam(plane: Plane3, curves: Curve[]): string {
  const ents: Record<string, unknown>[] = []
  let n = 1
  const pts = new Map<string, string>()
  const pt = (p: [number, number]) => {
    const key = p.join(',')
    let id = pts.get(key)
    if (!id) { id = 'p' + n++; pts.set(key, id); ents.push({ id, type: 'point', x: p[0], y: p[1] }) }
    return id
  }
  const line = (a: [number, number], b: [number, number]) => ents.push({ id: 'l' + n++, type: 'line', p1: pt(a), p2: pt(b) })
  for (const c of curves) {
    if (c.k === 'rect') {
      const corners: [number, number][] = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]]
      corners.forEach((p, i) => line(p, corners[(i + 1) % 4]))
    } else if (c.k === 'line') line(c.a, c.b)
    else if (c.k === 'arc') ents.push({ id: 'l' + n++, type: 'arc', c: pt(c.c), s: pt(c.s), e: pt(c.e) })
    else ents.push({ id: 'l' + n++, type: 'circle', c: pt(c.c), r: c.r })
  }
  return JSON.stringify({ plane, face: null, model: { entities: ents, constraints: [], next: n } })
}


/** Add a finished sketch feature without the UI (deterministic geometry for the solid tools). */
export async function addSketch(app: App, plane: Plane3, curves: Curve[]) {
  const id = await app.ev((c, s) => c.doc.getState().addFeature('sketch', { sketch: s }), sketchParam(plane, curves))
  await app.idle()
  return id as string
}
