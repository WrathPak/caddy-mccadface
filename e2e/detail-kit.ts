import type { App } from './helpers'

/** Shared setup for the DETAIL specs: bodies without the dialogs, face selection by normal. */
export async function addBox(app: App, w = 20, d = 20, h = 20, at: [number, number, number] = [0, 0, 0]) {
  await app.ev((c, a) => c.doc.getState().addFeature('box', { width: a[0], depth: a[1], height: a[2], position: a[3] }), [w, d, h, at])
  await app.idle()
}
export async function addCylinder(app: App, radius: number, height: number) {
  await app.ev((c, a) => c.doc.getState().addFeature('cylinder', { plane: 'XY', position: [0, 0, 0], radius: a[0], height: a[1] }), [radius, height])
  await app.idle()
}
export async function frame(app: App) {
  await app.ev((c) => { c.runCommand('view.home'); c.runCommand('view.frame') })
  await app.cameraStable()
}

/** Select a face of body `index` whose triangles satisfy `pick` (normal) and open the Detail tab. */
export async function selectFace(app: App, kind: 'top' | 'side' | 'sideX' | 'hole', index = 0) {
  const sel = await app.ev((c, a) => {
    const b = c.doc.getState().geometry[a.index]
    const m = b.mesh
    for (let t = 0; t < m.indices.length / 3; t++) {
      const i = m.indices[t * 3] * 3
      const n = [m.normals[i], m.normals[i + 1], m.normals[i + 2]]
      const r = Math.hypot(m.positions[i], m.positions[i + 1])
      const ok = a.kind === 'top' ? n[2] > 0.99 : a.kind === 'sideX' ? n[0] > 0.99 : a.kind === 'hole' ? Math.abs(n[2]) < 0.05 && r < 5 : Math.abs(n[2]) < 0.05
      if (ok) return { kind: 'face', id: b.id, index: m.faceIds[t] }
    }
    return null
  }, { kind, index })
  await app.ev((c, s) => c.ui.getState().setSelection([s]), sel)
  await app.tab('Detail')
}
