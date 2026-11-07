import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, type App } from './helpers'
import { clickWorld, px, settle, type P3 } from './solids-kit'

/* Shared helpers for the mesh parity specs (64, 65). STL files are generated here (nothing is checked in); everything a user does goes through the mouse and keyboard, `app.ev` only reads state. */

export type Tri = [P3, P3, P3]

/** Binary STL of triangles (CCW seen from outside = outward). */
export function stlOf(tris: Tri[], name = 'caddy e2e'): Buffer {
  const buf = Buffer.alloc(84 + tris.length * 50)
  buf.write(name, 0)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, k) => {
    const o = 84 + k * 50
    const u = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]]
    const v = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]]
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const l = Math.hypot(n[0], n[1], n[2]) || 1
    ;[n[0] / l, n[1] / l, n[2] / l].forEach((x, i) => buf.writeFloatLE(x, o + i * 4))
    t.forEach((p, j) => p.forEach((x, i) => buf.writeFloatLE(x, o + 12 + j * 12 + i * 4)))
  })
  return buf
}
export function writeStl(name: string, tris: Tri[]): string {
  const file = path.join(os.tmpdir(), `caddy-mesh-${name}.stl`)
  fs.writeFileSync(file, stlOf(tris, name))
  return file
}
/** An OBJ of triangles (shared vertices), for the format Fusion imports and this app does not. */
export function writeObj(name: string, tris: Tri[]): string {
  const file = path.join(os.tmpdir(), `caddy-mesh-${name}.obj`)
  const id = new Map<string, number>()
  const lines: string[] = []
  const f: string[] = []
  const vid = (p: P3) => { const k = p.join(','); let v = id.get(k); if (!v) { v = id.size + 1; id.set(k, v); lines.push(`v ${p[0]} ${p[1]} ${p[2]}`) } return v }
  for (const t of tris) f.push(`f ${vid(t[0])} ${vid(t[1])} ${vid(t[2])}`)
  fs.writeFileSync(file, lines.join('\n') + '\n' + f.join('\n') + '\n')
  return file
}

/** A w x d x h box from `at`, every face split into n x n quads (12 n^2 triangles), outward winding. */
export function boxTris(w: number, d: number, h: number, at: P3 = [0, 0, 0], n = 1): Tri[] {
  const out: Tri[] = []
  const [x0, y0, z0] = at
  // each face: origin, u axis, v axis (u x v = outward normal)
  const faces: [P3, P3, P3][] = [
    [[x0, y0, z0], [0, d, 0], [w, 0, 0]], // bottom -Z
    [[x0, y0, z0 + h], [w, 0, 0], [0, d, 0]], // top +Z
    [[x0, y0, z0], [w, 0, 0], [0, 0, h]], // front -Y
    [[x0, y0 + d, z0], [0, 0, h], [w, 0, 0]], // back +Y
    [[x0, y0, z0], [0, 0, h], [0, d, 0]], // left -X
    [[x0 + w, y0, z0], [0, d, 0], [0, 0, h]], // right +X
  ]
  for (const [o, u, v] of faces) {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const p = (a: number, b: number): P3 => [o[0] + (u[0] * a + v[0] * b) / n, o[1] + (u[1] * a + v[1] * b) / n, o[2] + (u[2] * a + v[2] * b) / n]
      out.push([p(i, j), p(i + 1, j), p(i + 1, j + 1)], [p(i, j), p(i + 1, j + 1), p(i, j + 1)])
    }
  }
  return out
}

/** UV sphere, closed, outward. */
export function sphereTris(r: number, seg = 32, rings = 16, at: P3 = [0, 0, 0]): Tri[] {
  const P = (i: number, j: number): P3 => {
    const th = (Math.PI * j) / rings, ph = (2 * Math.PI * (i % seg)) / seg
    return [at[0] + r * Math.sin(th) * Math.cos(ph), at[1] + r * Math.sin(th) * Math.sin(ph), at[2] + r * Math.cos(th)]
  }
  const out: Tri[] = []
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    if (j > 0) out.push([P(i, j), P(i, j + 1), P(i + 1, j)])
    if (j < rings - 1) out.push([P(i + 1, j), P(i, j + 1), P(i + 1, j + 1)])
  }
  return out
}

/** Lathe (solid of revolution about Z) of a profile [(r, z) ...] running bottom (r = 0) to top (r = 0). Closed, outward. */
export function latheTris(profile: [number, number][], seg = 40): Tri[] {
  const out: Tri[] = []
  const P = (k: number, i: number): P3 => [profile[k][0] * Math.cos((2 * Math.PI * (i % seg)) / seg), profile[k][0] * Math.sin((2 * Math.PI * (i % seg)) / seg), profile[k][1]]
  for (let k = 0; k < profile.length - 1; k++) for (let i = 0; i < seg; i++) {
    const a = P(k, i), b = P(k, i + 1), c = P(k + 1, i + 1), d = P(k + 1, i)
    if (profile[k][0] === 0) out.push([a, c, d])
    else if (profile[k + 1][0] === 0) out.push([a, b, d])
    else out.push([a, b, c], [a, c, d])
  }
  return out
}
/** A pawn-like mini figure about 56 mm tall: base, stem, collar, round head. Solid, closed. */
export function figureTris(seg = 40): Tri[] {
  const prof: [number, number][] = [[0, 0], [12, 0], [12, 4], [8, 8], [4.5, 22], [4.5, 30], [9, 33], [9, 35], [4, 36]]
  for (let a = 1; a <= 11; a++) { const t = (Math.PI * a) / 12; prof.push([8 * Math.sin(t) * 0.999 + 0.01, 46 - 10 * Math.cos(t)]) }
  prof.push([0, 56])
  return latheTris(prof, seg)
}

/** An L bracket (legs 40 x 30, thickness 10, depth 20) as a prism, triangulated without T-junctions. */
export function lBracketTris(depth = 20): Tri[] {
  const poly: [number, number][] = [[0, 0], [40, 0], [40, 10], [10, 10], [10, 30], [0, 30]]
  const cap: [number, number][][] = [[poly[0], poly[1], poly[2]], [poly[0], poly[2], poly[3]], [poly[0], poly[3], poly[4]], [poly[0], poly[4], poly[5]]]
  const out: Tri[] = []
  for (const [a, b, c] of cap) {
    out.push([[a[0], a[1], 0], [c[0], c[1], 0], [b[0], b[1], 0]]) // bottom faces -Z
    out.push([[a[0], a[1], depth], [b[0], b[1], depth], [c[0], c[1], depth]]) // top faces +Z
  }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    out.push([[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], depth]], [[a[0], a[1], 0], [b[0], b[1], depth], [a[0], a[1], depth]])
  }
  return out
}

/** Drop triangles by index (a scan with holes). */
export const without = (t: Tri[], drop: number[]) => t.filter((_, i) => !drop.includes(i))
/** Flip every triangle (inverted normals). */
export const flipped = (t: Tri[]): Tri[] => t.map(([a, b, c]) => [a, c, b])

/** Closed slab: bumpy top (2 cells^2 triangles), flat bottom, four walls. */
export function slabTris(cells: number, size = 100, thick = 10): Tri[] {
  const h = (x: number, y: number) => thick + 3 * Math.sin(x / 11) * Math.cos(y / 9)
  const step = size / cells
  const out: Tri[] = []
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const x0 = i * step, x1 = x0 + step, y0 = j * step, y1 = y0 + step
    const a: P3 = [x0, y0, h(x0, y0)], b: P3 = [x1, y0, h(x1, y0)], c: P3 = [x1, y1, h(x1, y1)], d: P3 = [x0, y1, h(x0, y1)]
    out.push([a, b, c], [a, c, d])
  }
  const z = (x: number, y: number): P3 => [x, y, 0]
  // the bottom is gridded too, so the walls meet it vertex to vertex (a long bottom edge would leave T-junctions and the mesh would not be closed)
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const x0 = i * step, x1 = x0 + step, y0 = j * step, y1 = y0 + step
    out.push([z(x0, y0), z(x0, y1), z(x1, y1)], [z(x0, y0), z(x1, y1), z(x1, y0)])
  }
  for (let i = 0; i < cells; i++) {
    const t0 = i * step, t1 = t0 + step
    const wall = (p: (t: number) => [number, number], flip: boolean) => {
      const [ax, ay] = p(t0), [bx, by] = p(t1)
      const A: P3 = [ax, ay, 0], B: P3 = [bx, by, 0], C: P3 = [bx, by, h(bx, by)], D: P3 = [ax, ay, h(ax, ay)]
      out.push(...((flip ? [[A, C, B], [A, D, C]] : [[A, B, C], [A, C, D]]) as Tri[]))
    }
    wall((t) => [t, 0], false)
    wall((t) => [t, size], true)
    wall((t) => [0, t], true)
    wall((t) => [size, t], false)
  }
  return out
}

/** Import an STL by the Import button and wait for the bodies. */
export async function importStl(app: App, file: string, count = 1, timeout = 60000) {
  const [chooser] = await Promise.all([app.page.waitForEvent('filechooser'), app.ribbon('Import').first().click()])
  await chooser.setFiles(file)
  await expect.poll(() => app.bodies().then((b) => b.length), { timeout }).toBe(count)
  await app.idle()
  await settle(app)
}
export const geom = (app: App) => app.ev((c) => c.doc.getState().geometry.map((b: any) => ({ // eslint-disable-line
  id: b.id, name: b.name, kind: b.kind, tris: b.mesh.indices.length / 3, faces: new Set(Array.from(b.mesh.faceIds ?? [])).size,
})))

/** Mesh stats from the display arrays: triangles, welded vertices, open (boundary) edges, non-manifold edges, signed volume. */
export const meshStats = (app: App, i = 0) => app.ev((c, i) => {
  const b = c.doc.getState().geometry[i]
  const p: Float32Array = b.mesh.positions, ix: ArrayLike<number> = b.mesh.indices
  const key = (k: number) => `${Math.round(p[k * 3] * 1e4)},${Math.round(p[k * 3 + 1] * 1e4)},${Math.round(p[k * 3 + 2] * 1e4)}`
  const id = new Map<string, number>()
  const vid = (k: number) => { const s = key(k); let v = id.get(s); if (v === undefined) { v = id.size; id.set(s, v) } return v }
  const edges = new Map<string, number>()
  let vol = 0
  for (let t = 0; t < ix.length; t += 3) {
    const v = [vid(ix[t]), vid(ix[t + 1]), vid(ix[t + 2])]
    for (let e = 0; e < 3; e++) { const a = v[e], bb = v[(e + 1) % 3]; const k = a < bb ? a + '_' + bb : bb + '_' + a; edges.set(k, (edges.get(k) ?? 0) + 1) }
    const a = ix[t] * 3, bb = ix[t + 1] * 3, cc = ix[t + 2] * 3
    vol += (p[a] * (p[bb + 1] * p[cc + 2] - p[bb + 2] * p[cc + 1]) - p[a + 1] * (p[bb] * p[cc + 2] - p[bb + 2] * p[cc]) + p[a + 2] * (p[bb] * p[cc + 1] - p[bb + 1] * p[cc])) / 6
  }
  let open = 0, nonManifold = 0
  for (const n of edges.values()) { if (n === 1) open++; else if (n > 2) nonManifold++ }
  return { tris: ix.length / 3, verts: id.size, open, nonManifold, signedVolume: vol }
}, i)

export const featStates = async (app: App) => (await app.features()).map((f) => `${f.type}:${f.state}${f.error ? ' (' + f.error + ')' : ''}`)
export { clickWorld, px }

/** Open a Mesh tab tool by its ribbon button. */
export async function meshTool(app: App, name: string | RegExp) {
  await app.tab('Mesh')
  await app.ribbon(name).first().click()
  await expect(app.inspector()).toBeVisible()
}
/** Bodies' ids in order. */
export const bodyIds = (app: App) => app.ev((c) => c.doc.getState().geometry.map((b: any) => b.id as string)) // eslint-disable-line

/** Signed volume of triangles (what the file says, before the app touches it). */
export function triVolume(t: Tri[]): number {
  let v = 0
  for (const [a, b, c] of t) v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
  return v
}
/** Index of the triangle whose centre is nearest to p (to cut holes where a user would see a scan defect). */
export function nearestTri(t: Tri[], p: P3): number {
  let best = 0, bd = Infinity
  t.forEach(([a, b, c], i) => {
    const d = Math.hypot((a[0] + b[0] + c[0]) / 3 - p[0], (a[1] + b[1] + c[1]) / 3 - p[1], (a[2] + b[2] + c[2]) / 3 - p[2])
    if (d < bd) { bd = d; best = i }
  })
  return best
}

/** Switch a labelled checkbox of the open dialog on. */
export const toggle = (app: App, label: string) => app.inspector().locator('.field', { hasText: label }).locator('button,input,[role=switch]').first().click()
/** The open dialog's text, or '' when none is open (innerText on a missing dialog would wait for it). */
export const dialogText = async (app: App) => ((await app.inspector().isVisible()) ? app.inspector().innerText() : '')
