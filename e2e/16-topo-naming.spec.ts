import { test, expect, type App } from './helpers'

/** Bounding-box centre of the (single) face whose primary name contains `part`, read from the live mesh in the page. */
async function faceCentroid(app: App, part: string) {
  return app.ev((c, part) => {
    const m = c.doc.getState().geometry[0].mesh
    const ids = (m.faceNames as string[][]).map((n, i) => (n[0].includes(part) ? i : -1)).filter((i) => i >= 0)
    if (ids.length !== 1) return { count: ids.length, c: null as number[] | null, name: null as string | null }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let t = 0; t < m.indices.length / 3; t++) {
      if (m.faceIds[t] !== ids[0]) continue
      for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) {
        const v = m.positions[m.indices[t * 3 + k] * 3 + d]
        lo[d] = Math.min(lo[d], v); hi[d] = Math.max(hi[d], v)
      }
    }
    return { count: 1, c: [0, 1, 2].map((d) => (lo[d] + hi[d]) / 2), name: (m.faceNames as string[][])[ids[0]][0] as string }
  }, part)
}

test('fillet stays on its edge when the box under it is resized and moved', async ({ app, page }) => {
  await app.open()
  await app.ev((c) => c.doc.getState().addFeature('box', { width: 20, depth: 20, height: 20, position: [0, 0, 0] }))
  await expect.poll(async () => (await app.bodies()).length).toBe(1)
  await app.idle()

  // pick the top edge on the +X side (running along Y) and fillet it through the dialog
  const edge = await app.ev((c) => {
    const b = c.doc.getState().geometry[0]
    const m = b.mesh
    const acc = new Map<number, number[]>()
    for (let s = 0; s < m.edges.length / 6; s++) {
      const id = m.edgeIds[s]
      const a = acc.get(id) ?? [0, 0, 0, 0, 0, 0, 0]
      const o = s * 6
      a[0] += (m.edges[o] + m.edges[o + 3]) / 2; a[1] += (m.edges[o + 1] + m.edges[o + 4]) / 2; a[2] += (m.edges[o + 2] + m.edges[o + 5]) / 2
      a[3] += Math.abs(m.edges[o + 4] - m.edges[o + 1]); a[6] += 1
      acc.set(id, a)
    }
    let best = -1, bd = Infinity
    for (const [id, a] of acc) {
      const mid = [a[0] / a[6], a[1] / a[6], a[2] / a[6]]
      if (a[3] < 15) continue // not running along Y
      const d = Math.hypot(mid[0] - 10, mid[1], mid[2] - 20)
      if (d < bd) { bd = d; best = id }
    }
    return { id: b.id as string, index: best }
  })
  expect(edge.index).toBeGreaterThanOrEqual(0)
  await app.ev((c, e) => { c.ui.getState().setSelectionFilter('edge'); c.ui.getState().setSelection([{ kind: 'edge', id: e.id, index: e.index }]) }, edge)
  await app.tab('Solid')
  await app.ribbon('Fillet').first().click()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Fillet')
  await app.field('Radius', '2')
  await app.ok()
  expect((await app.features()).map((f) => [f.type, f.state])).toEqual([['box', 'ok'], ['fillet', 'ok']])

  const before = await faceCentroid(app, ':fillet:')
  expect(before.count).toBe(1)
  expect(before.c![0]).toBeGreaterThan(8.5) // the +X side of the 20 wide box
  expect(before.c![0]).toBeLessThan(10.5)

  // a ref whose name is gone but whose position still fits is re-bound with a warning, and the Inspector says which one
  const original = await app.ev((c) => c.doc.getState().features.find((x: any) => x.type === 'fillet').params.edges as string[]) // eslint-disable-line
  await app.ev((c) => {
    const d = c.doc.getState()
    const f = d.features.find((x: any) => x.type === 'fillet') // eslint-disable-line
    const edges = (f.params.edges as string[]).map((s) => JSON.stringify({ ...JSON.parse(s), name: 'f0:vanished' }))
    d.updateFeature(f.id, { ...f.params, edges })
  })
  await app.idle()
  const chips = page.locator('.tl .chip')
  await expect.poll(async () => (await app.features())[1].state).toBe('warning')
  await chips.nth(1).dblclick()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Fillet')
  await expect(app.inspector().locator('[data-sel-key="edges"][data-ref-flag="rebound"]')).toBeVisible()
  await expect(app.inspector().getByTestId('feature-note')).toContainText('re-bound')
  await app.shot('topo-naming-rebound-flag')
  await app.inspector().getByRole('button', { name: 'Cancel' }).click()
  await app.ev((c, edges) => {
    const d = c.doc.getState()
    const f = d.features.find((x: any) => x.type === 'fillet') // eslint-disable-line
    d.updateFeature(f.id, { ...f.params, edges })
  }, original)
  await app.idle()
  await expect.poll(async () => (await app.features())[1].state).toBe('ok')

  // edit the box from the timeline: taller, wider, and moved 50 mm along X. The nearest edge to the old spot is now a
  // different one, so only the name can keep the fillet where it was.
  await chips.nth(0).dblclick()
  await expect(app.inspector().locator('.panel-title')).toHaveText('Box')
  await app.field('Width', '40')
  await app.field('Height', '40')
  await app.vec('Base center', 0, '50')
  await app.ok()

  const feats = await app.features()
  expect(feats.map((f) => f.state)).toEqual(['ok', 'ok'])
  const after = await faceCentroid(app, ':fillet:')
  expect(after.count).toBe(1)
  expect(after.name).toBe(before.name)
  expect(after.c![0]).toBeGreaterThan(68) // 50 + 40 / 2 = 70: the +X side of the moved box
  expect(after.c![2]).toBeGreaterThan(38) // the new top at z = 40
  await app.shot('topo-naming-fillet-follows')
})
