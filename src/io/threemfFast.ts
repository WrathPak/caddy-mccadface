/**
 * 3MF reader that works in a worker (no DOM): a byte-level XML scanner for the core model, so a file with millions of
 * triangles is never turned into one giant string or a DOM tree. Handles objects with meshes, component objects, build
 * items, per-item transforms and the model unit; the result is in millimetres.
 */
import { unzipSync } from 'fflate'

export interface RawMesh { name: string; positions: Float32Array; /** absent: a triangle soup */ indices?: Uint32Array }

const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }

class Grow<T extends Float32Array | Uint32Array> {
  data: T
  n = 0
  constructor(private ctor: new (n: number) => T, cap = 1024) { this.data = new ctor(cap) }
  push(v: number) {
    if (this.n === this.data.length) { const d = new this.ctor(this.data.length * 2); d.set(this.data); this.data = d }
    this.data[this.n++] = v
  }
  done(): T { return this.data.slice(0, this.n) as T }
}

interface Obj { id: string; name: string; verts?: Grow<Float32Array>; tris?: Grow<Uint32Array>; components: { id: string; m: number[] | null }[] }

const LT = 60, GT = 62, SLASH = 47, QUOTE = 34, APOS = 39, EQ = 61
const isSpace = (c: number) => c === 32 || c === 10 || c === 13 || c === 9

function num(b: Uint8Array, s: number, e: number): number {
  let i = s, sign = 1, mant = 0, exp = 0
  if (b[i] === 45) { sign = -1; i++ } else if (b[i] === 43) i++
  let digits = 0
  for (; i < e && b[i] >= 48 && b[i] <= 57; i++, digits++) mant = mant * 10 + (b[i] - 48)
  if (b[i] === 46) {
    i++
    for (; i < e && b[i] >= 48 && b[i] <= 57; i++, digits++) { mant = mant * 10 + (b[i] - 48); exp-- }
  }
  if (!digits) return parseFloat(new TextDecoder().decode(b.subarray(s, e)))
  if (b[i] === 101 || b[i] === 69) {
    i++
    let es = 1
    if (b[i] === 45) { es = -1; i++ } else if (b[i] === 43) i++
    let ev = 0
    for (; i < e && b[i] >= 48 && b[i] <= 57; i++) ev = ev * 10 + (b[i] - 48)
    exp += es * ev
  }
  return sign * mant * Math.pow(10, exp)
}

/** Walk the start tags of an XML document, calling `tag(name, attrs, selfClosing)`; attribute values are decoded lazily. */
function scan(b: Uint8Array, tag: (name: string, attr: (k: string) => [number, number] | null, closing: boolean) => void, close: (name: string) => void) {
  const dec = new TextDecoder()
  const len = b.length
  let i = 0
  while (i < len) {
    if (b[i] !== LT) { i++; continue }
    i++
    const c = b[i]
    if (c === 63 || c === 33) { // <? or <! (declaration, comment, cdata)
      while (i < len && b[i] !== GT) i++
      i++
      continue
    }
    if (c === SLASH) {
      const s = ++i
      while (i < len && b[i] !== GT) i++
      close(dec.decode(b.subarray(s, i)).trim().replace(/^.*:/, ''))
      i++
      continue
    }
    const ns = i
    while (i < len && !isSpace(b[i]) && b[i] !== GT && b[i] !== SLASH) i++
    let name = dec.decode(b.subarray(ns, i))
    const colon = name.indexOf(':')
    if (colon >= 0) name = name.slice(colon + 1)
    const as = i
    // find the end of the tag, respecting quoted values
    let q = 0
    while (i < len && (q || b[i] !== GT)) {
      if (q) { if (b[i] === q) q = 0 } else if (b[i] === QUOTE || b[i] === APOS) q = b[i]
      i++
    }
    const ae = i
    const selfClosing = b[ae - 1] === SLASH
    const attr = (k: string): [number, number] | null => {
      // match ` k="..."` inside [as, ae)
      for (let p = as; p < ae; p++) {
        if (!isSpace(b[p]) && p !== as) continue
        let j = p
        while (j < ae && isSpace(b[j])) j++
        let m = 0
        while (m < k.length && b[j + m] === k.charCodeAt(m)) m++
        if (m !== k.length) continue
        let e = j + m
        while (e < ae && isSpace(b[e])) e++
        if (b[e] !== EQ) continue
        e++
        while (e < ae && isSpace(b[e])) e++
        const qq = b[e]
        if (qq !== QUOTE && qq !== APOS) continue
        const vs = e + 1
        let ve = vs
        while (ve < ae && b[ve] !== qq) ve++
        return [vs, ve]
      }
      return null
    }
    tag(name, attr, selfClosing)
    if (selfClosing) close(name)
    i++
  }
}

type Mat = number[] // row-major 4x3 as the spec writes it: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32

const IDENT: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
/** a * b for row-vector convention: apply a first, then b */
function mul(a: Mat, b: Mat): Mat {
  const o: Mat = new Array(12)
  for (let r = 0; r < 4; r++) {
    const x = r < 3 ? a[r * 3] : a[9], y = r < 3 ? a[r * 3 + 1] : a[10], z = r < 3 ? a[r * 3 + 2] : a[11]
    for (let c = 0; c < 3; c++) o[r * 3 + c] = x * b[c] + y * b[3 + c] + z * b[6 + c] + (r === 3 ? b[9 + c] : 0)
  }
  return o
}

/** Parse the model parts of a 3MF archive into meshes (transforms applied, millimetres). */
export function parse3mfFast(bytes: Uint8Array): RawMesh[] {
  const files = unzipSync(bytes, { filter: (f) => f.name.toLowerCase().endsWith('.model') })
  const names = Object.keys(files)
  if (!names.length) throw new Error('This does not look like a 3MF file (no 3D model inside)')
  // the root model is the one the package points at; fall back to the first
  const modelName = names.find((n) => n.toLowerCase() === '3d/3dmodel.model') ?? names[0]
  const b = files[modelName]
  const dec = new TextDecoder()
  const ents: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  const str = (r: [number, number] | null) =>
    r ? dec.decode(b.subarray(r[0], r[1])).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ents[e.toLowerCase()])) : ''

  let unit = 1
  const objs = new Map<string, Obj>()
  const build: { id: string; m: Mat }[] = []
  let cur: Obj | null = null
  let inBuild = false

  const matOf = (r: [number, number] | null): Mat | null => {
    if (!r) return null
    const parts = str(r).trim().split(/\s+/).map(Number)
    return parts.length === 12 && parts.every(Number.isFinite) ? parts : null
  }

  scan(
    b,
    (name, attr) => {
      if (name === 'vertex') {
        const x = attr('x'), y = attr('y'), z = attr('z')
        if (cur?.verts && x && y && z) { cur.verts.push(num(b, x[0], x[1])); cur.verts.push(num(b, y[0], y[1])); cur.verts.push(num(b, z[0], z[1])) }
      } else if (name === 'triangle') {
        const a = attr('v1'), bb = attr('v2'), c = attr('v3')
        if (cur?.tris && a && bb && c) { cur.tris.push(num(b, a[0], a[1])); cur.tris.push(num(b, bb[0], bb[1])); cur.tris.push(num(b, c[0], c[1])) }
      } else if (name === 'object') {
        const id = str(attr('id'))
        cur = { id, name: str(attr('name')), components: [] }
        objs.set(id, cur)
      } else if (name === 'mesh') {
        if (cur) { cur.verts = new Grow(Float32Array, 4096); cur.tris = new Grow(Uint32Array, 4096) }
      } else if (name === 'component') {
        if (cur) cur.components.push({ id: str(attr('objectid')), m: matOf(attr('transform')) })
      } else if (name === 'build') inBuild = true
      else if (name === 'item') {
        if (inBuild) build.push({ id: str(attr('objectid')), m: matOf(attr('transform')) ?? IDENT })
      } else if (name === 'model') {
        const u = str(attr('unit')).toLowerCase()
        if (u && UNIT_MM[u]) unit = UNIT_MM[u]
      }
    },
    (name) => {
      if (name === 'object') cur = null
      else if (name === 'build') inBuild = false
    },
  )

  const out: RawMesh[] = []
  const flatten = (o: Obj, m: Mat, depth: number, label: string) => {
    if (depth > 16) throw new Error('3MF components are nested too deeply')
    if (o.verts && o.tris && o.tris.n) {
      const v = o.verts.done(), t = o.tris.done()
      const nv = v.length / 3
      for (let k = 0; k < t.length; k++) if (t[k] >= nv) throw new Error('3MF triangle refers to a vertex that does not exist')
      const p = new Float32Array(v.length)
      for (let i = 0; i < v.length; i += 3) {
        const x = v[i], y = v[i + 1], z = v[i + 2]
        p[i] = (x * m[0] + y * m[3] + z * m[6] + m[9]) * unit
        p[i + 1] = (x * m[1] + y * m[4] + z * m[7] + m[10]) * unit
        p[i + 2] = (x * m[2] + y * m[5] + z * m[8] + m[11]) * unit
      }
      out.push({ name: o.name || label || `Mesh${out.length + 1}`, positions: p, indices: t })
    }
    for (const c of o.components) {
      const child = objs.get(c.id)
      if (child) flatten(child, c.m ? mul(c.m, m) : m, depth + 1, o.name || label)
    }
  }
  if (build.length) for (const it of build) { const o = objs.get(it.id); if (o) flatten(o, it.m, 0, '') }
  else for (const o of objs.values()) flatten(o, IDENT, 0, '')
  if (!out.length) throw new Error('No mesh objects found in 3MF')
  return out
}
