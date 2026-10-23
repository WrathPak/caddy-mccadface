/** Strand planning (roots + directions) and centerline construction with styling and wall clipping. */
import { rng, sampleRoots, snappedThickness, type Surf } from './sampling'
import type { HairParams, V3 } from './schema'
import type { Axis, Caster } from './wall'
import { add, cross, dot, len, lerp, mul, norm, perp, rotate, sub } from './vec'

export interface Plan {
  count: number
  p: Float32Array
  n: Float32Array
  dir: Float32Array
  /** 1 = strand cannot be placed (e.g. print-aware on an upward-facing surface) */
  drop: Uint8Array
  capped: boolean
}

export interface Strand {
  /** centerline samples */
  pts: Float32Array
  /** cross-section scale per sample */
  scale: Float32Array
  /** direction hint for the section's thickness axis */
  up: V3
  /** where the strand meets the wall */
  contact: V3 | null
  inward: V3
}

const v3 = (a: Float32Array, i: number): V3 => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]

export function planStrands(s: Surf, P: HairParams, axis: Axis): Plan {
  const roots = sampleRoots(s, P)
  const N = roots.count
  if (!N) throw new Error('No strands could be placed; increase density or reduce the edge margin')
  const dir = new Float32Array(N * 3)
  const drop = new Uint8Array(N)
  const a = norm(axis.d)
  for (let i = 0; i < N; i++) {
    const p = v3(roots.p, i), n = v3(roots.n, i)
    let d: V3
    switch (P.dirMode) {
      case 'fixed': d = norm(P.fixedDir); break
      case 'radial': { const w = sub(p, axis.o); d = norm(sub(w, mul(a, dot(w, a)))); break }
      case 'point': d = norm(sub(P.targetPoint, p)); break
      default: d = n
    }
    if (!d.some(Boolean)) d = n
    if (P.dirMode !== 'normal' && P.normalBlend > 0) d = norm(lerp(d, n, P.normalBlend))
    if (P.printAware) {
      const hl = Math.hypot(d[0], d[1])
      if (hl < 0.2) drop[i] = 1
      else d = [d[0] / hl, d[1] / hl, 0]
    }
    dir.set(d, i * 3)
  }
  return { count: N, p: roots.p, n: roots.n, dir, drop, capped: roots.capped }
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const smooth = (x: number) => x * x * (3 - 2 * x)

function centerline(P: HairParams, start: V3, dir: V3, n: V3, L: number, R: () => number, offset: V3 | null): V3[] {
  const pa = P.printAware
  let d = dir
  if (P.jitter > 0) {
    const ang = ((R() * 2 - 1) * P.jitter * Math.PI) / 180
    d = pa ? rotate(d, [0, 0, 1], ang) : rotate(d, rotate(perp(d), d, R() * 2 * Math.PI), ang)
  }
  const cycles = (P.waveFreq * L) / 10
  const straight = P.waveAmp <= 0 && P.curl === 0 && P.droop <= 0 && !offset
  if (straight) return [start, add(start, mul(d, L))]
  const up: V3 = pa ? [0, 0, 1] : Math.abs(dot(d, n)) < 0.9 ? n : perp(d)
  let u = norm(cross(up, d))
  if (!u.some(Boolean)) u = perp(d)
  const v = cross(d, u)
  const nseg = clamp(4 + (P.waveAmp > 0 ? Math.ceil(cycles * 10) : 0) + Math.ceil(Math.abs(P.curl) / 15) + (P.droop > 0 ? 4 : 0), 4, 48)
  const curlAxis: V3 = pa ? [0, 0, 1] : v
  const curlSign = R() < 0.5 ? -1 : 1
  const phase = R() * 2 * Math.PI
  const out: V3[] = []
  let pos = start, prev = d
  for (let k = 0; k <= nseg; k++) {
    const t = k / nseg
    const h = rotate(d, curlAxis, (curlSign * P.curl * Math.PI * t * t) / 180)
    if (k > 0) pos = add(pos, mul(add(prev, h), (0.5 * L) / nseg))
    prev = h
    let q = pos
    if (P.waveAmp > 0) q = add(q, mul(u, P.waveAmp * Math.sin(phase + 2 * Math.PI * cycles * t) * smooth(Math.min(1, t * 5))))
    if (offset) q = add(q, mul(offset, t * t))
    if (!pa && P.droop > 0) q = [q[0], q[1], q[2] - P.droop * t * t]
    out.push(q)
  }
  return out
}

function pointAt(poly: V3[], arc: number[], s: number): V3 {
  let j = 1
  while (j < arc.length - 1 && arc[j] < s) j++
  const span = arc[j] - arc[j - 1] || 1
  return lerp(poly[j - 1], poly[j], clamp((s - arc[j - 1]) / span, 0, 1))
}

export function buildStrands(plan: Plan, P: HairParams, caster: Caster | null): { strands: Strand[]; dropped: number } {
  const live: number[] = []
  for (let i = 0; i < plan.count; i++) if (!plan.drop[i]) live.push(i)
  const size = Math.max(P.width, snappedThickness(P))
  const L = P.length
  const toWall = !!caster && P.lengthMode === 'toWall'

  // clump seeds: strands converge on the tip of the nearest seed
  const K = Math.min(Math.round(P.clumpCount), live.length)
  const seeds: number[] = []
  if (K > 0 && P.clumpStrength > 0) {
    const r = rng(P.seed * 31 + 5)
    while (seeds.length < K) { const c = live[Math.floor(r() * live.length)]; if (!seeds.includes(c)) seeds.push(c) }
  }
  const tipOf = (i: number) => add(v3(plan.p, i), mul(v3(plan.dir, i), L))

  const strands: Strand[] = []
  let dropped = plan.drop.reduce((a, b) => a + b, 0)
  for (const i of live) {
    const R = rng(P.seed * 7919 + i * 104729 + 13)
    const p = v3(plan.p, i), n = v3(plan.n, i), dir = v3(plan.dir, i)
    const sink = clamp((0.6 * size) / Math.max(0.3, dot(dir, n)), 0.2, 2 * size + 0.4)
    const start = sub(p, mul(dir, sink))
    const Lv = toWall ? 2 * L : L * (1 + (P.lengthVar / 100) * (R() * 2 - 1))

    let offset: V3 | null = null
    if (seeds.length) {
      let best = -1, bd = Infinity
      for (const sd of seeds) {
        const q = v3(plan.p, sd)
        const dd = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2
        if (dd < bd) { bd = dd; best = sd }
      }
      if (best !== i) {
        offset = mul(sub(tipOf(best), tipOf(i)), P.clumpStrength)
        if (P.printAware) offset = [offset[0], offset[1], 0]
      }
    }

    const poly = centerline(P, start, dir, n, Lv + sink, R, offset)
    let contact: V3 | null = null
    let inward: V3 = dir
    if (caster) {
      for (let j = 0; j + 1 < poly.length && !contact; j++) {
        const dv = sub(poly[j + 1], poly[j]), sl = len(dv)
        if (sl < 1e-9) continue
        const dn = mul(dv, 1 / sl)
        const h = caster(poly[j], dn, sl)
        if (h !== null) { contact = add(poly[j], mul(dn, h)); inward = dn; poly.length = j + 1; poly.push(contact) }
      }
      if (!contact && !toWall) {
        const a = poly[poly.length - 2], b = poly[poly.length - 1]
        const dn = norm(sub(b, a))
        const h = caster(b, dn, Math.max(2, 0.6 * L))
        if (h !== null) { contact = add(b, mul(dn, h)); inward = dn; poly.push(contact) }
      }
      if (!contact && toWall) { dropped++; continue }
      if (contact && P.tipOverlap > 0) poly.push(add(contact, mul(inward, P.tipOverlap)))
    }

    // arc length parametrisation
    const arc = [0]
    for (let j = 1; j < poly.length; j++) arc.push(arc[j - 1] + len(sub(poly[j], poly[j - 1])))
    const total = arc[arc.length - 1]
    if (total < 1e-3) { dropped++; continue }
    const sc = contact ? arc[poly.length - (P.tipOverlap > 0 ? 2 : 1)] : -1
    const extra: number[] = []
    const fl = clamp(0.1 * total, 1, 4)
    if (P.rootFlare > 0) extra.push(fl * 0.35, fl * 0.8, fl * 1.5)
    const bs = P.breakSize
    const neck = P.breakLine === 'groove' && contact
    if (neck) extra.push(sc - bs, sc, sc + bs)
    const svals = [...new Set([...arc, ...extra.filter((x) => x > 1e-3 && x < total - 1e-3)])].sort((x, y) => x - y)

    const pts = new Float32Array(svals.length * 3), scale = new Float32Array(svals.length)
    svals.forEach((s, k) => {
      pts.set(pointAt(poly, arc, s), k * 3)
      let f = Math.max(0.15, 1 - (P.taper / 100) * (s / total))
      if (P.rootFlare > 0) f *= 1 + (P.rootFlare / 100) * Math.exp(-s / fl)
      if (neck) f *= 1 - 0.55 * Math.max(0, 1 - Math.abs(s - sc) / bs)
      scale[k] = f
    })
    strands.push({ pts, scale, up: P.printAware ? [0, 0, 1] : n, contact, inward })
  }
  return { strands, dropped }
}
