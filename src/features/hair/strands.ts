/** Strand planning (roots + directions), styled centerlines, edge fitting, and attachment to the sacrificial wall. */
import { blendedNormal, patchNormalAt, rng, sampleRoots, SegIndex, type Surf } from './sampling'
import type { HairParams, V3 } from './schema'
import { outline } from './sweep'
import type { Axis, Caster } from './wall'
import { add, cross, dot, len, lerp, mul, norm, perp, rotate, sub } from './vec'

export interface Plan {
  count: number
  p: Float32Array
  /** surface normal of the face the root sits on (smooth only within one face) */
  n: Float32Array
  dir: Float32Array
  /** triangle and smooth patch of each root */
  tri: Uint32Array
  patch: Int32Array
  /** 1 = strand cannot be placed (e.g. print-aware on an upward-facing surface, or pointing into the surface) */
  drop: Uint8Array
  capped: boolean
  /** roots rejected because the strand's footprint would reach the edge of the selected region (set by rawStrands) */
  edgeRejected: number
}

export interface Strand {
  /** centerline samples */
  pts: Float32Array
  /** cross-section scale per sample */
  scale: Float32Array
  /** direction hint for the section's thickness axis */
  up: V3
  /** where the strand meets the wall (null without a wall) */
  contact: V3 | null
  /** last centerline point (inside the wall by up to the tip overlap) */
  tip: V3
  /** arc length at which the centerline crosses the surface (the part before it is buried in the body) */
  rootArc: number
  /** the point where it crosses the surface (unchanged when the strand is bent later) */
  root: V3
  /** collision tests against the selected faces start after this arc length (the root zone is allowed to touch them) */
  exempt: number
  /** smooth patch the root sits on */
  patch: number
}

/** Natural (unclipped) strand: styled centerline starting inside the surface. */
export interface Raw {
  i: number
  poly: V3[]
  dir: V3
  n: V3
  start: V3
  len: number
  clump: V3 | null
  /** buried length before the surface crossing */
  sink: number
  exempt: number
  patch: number
}

/** What the strands must keep clear of: region edges (and face seams), plus how deep the body is under a root. */
export interface Fit {
  edges: SegIndex | null
  margin: number
  /** body thickness under a root (distance along -n to the next surface), Infinity when unknown */
  thickness?: (p: V3, n: V3) => number
}

const v3 = (a: Float32Array, i: number): V3 => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]

/** Biggest extent a strand section reaches from its centreline at scale 1 (sections are not always round). */
export function sectionRadius(P: HairParams): number {
  let r = 0
  for (const [a, b] of outline(P, 16)) r = Math.max(r, Math.hypot(a, b))
  return r
}

/** Buried depth of a root along the surface normal: explicit, or a safe automatic depth (at least 0.6 mm and 1.5 line widths). */
export const rootDepth = (P: HairParams) => (P.rootSink > 0 ? P.rootSink : Math.max(0.6, 1.5 * P.nozzle))

export function planStrands(s: Surf, P: HairParams, axis: Axis): Plan {
  const roots = sampleRoots(s, P)
  const N = roots.count
  if (!N) {
    throw new Error(P.distribution === 'rows'
      ? 'No strands could be placed: Rows follow horizontal layer lines, so they need a surface that is not flat. Choose another Pattern (Random or Grid), or increase the density / reduce the edge margin'
      : 'No strands could be placed; increase the density or reduce the edge margin')
  }
  const dir = new Float32Array(N * 3)
  const nrm = new Float32Array(N * 3)
  const patch = new Int32Array(N)
  const drop = new Uint8Array(N)
  const a = norm(axis.d)
  const mode = P.dirMode === 'normal' ? 'blend' : P.dirMode
  const seamIdx = mode === 'blend' && s.seams.length ? new SegIndex(s.pos, s.seams.map((e) => [e[0], e[1]] as const), Math.max(P.blendDistance, 0.01)) : null
  for (let i = 0; i < N; i++) {
    const p = v3(roots.p, i), t = roots.tri[i]
    const n = patchNormalAt(s, t, p)
    nrm.set(n, i * 3)
    patch[i] = s.patch[t]
    let d: V3
    switch (mode) {
      case 'fixed': d = norm(P.fixedDir); break
      case 'radial': { const w = sub(p, axis.o); d = norm(sub(w, mul(a, dot(w, a)))); break }
      case 'point': { d = norm(sub(P.targetPoint, p)); if (P.pointAway) d = mul(d, -1); break }
      case 'blend': d = seamIdx ? blendedNormal(s, seamIdx, t, p, n, P.blendDistance) : n; break
      default: d = n
    }
    if (!d.some(Boolean)) d = n
    if ((mode === 'radial' || mode === 'fixed' || mode === 'point') && P.normalBlend > 0) d = norm(lerp(d, n, P.normalBlend))
    if (P.printAware) {
      // strictly horizontal: z is exactly zero
      const hl = Math.hypot(d[0], d[1])
      if (hl < 0.2) drop[i] = 1
      else d = [d[0] / hl, d[1] / hl, 0]
    }
    if (dot(d, n) < 0.05) drop[i] = 1 // would lie along or inside the surface
    dir.set(d, i * 3)
  }
  return { count: N, p: roots.p, n: nrm, dir, tri: roots.tri, patch, drop, capped: roots.capped, edgeRejected: 0 }
}

/**
 * Fit data for a surface: the open boundary of the selection and the seams between its faces, so a strand
 * (whose root footprint has a real size) never overhangs an edge or a corner.
 */
export function makeFit(s: Surf, P: HairParams, thickness?: Fit['thickness']): Fit {
  const reach = sectionRadius(P) * (1 + P.rootFlare / 100) * 10 + P.edgeMargin
  const segs: (readonly [number, number])[] = s.boundary.map((e) => [e[0], e[1]] as const)
  // seams count in every direction mode: a root footprint that straddles a corner would poke out of the neighbouring face
  for (const e of s.seams) segs.push([e[0], e[1]])
  return { edges: segs.length ? new SegIndex(s.pos, segs, reach) : null, margin: P.edgeMargin, thickness }
}

/**
 * Radius of the strand's footprint on the surface plane at its root: every corner of the section (in the strand's own frame,
 * grown by the root flare) projected along the strand onto the plane of the surface.
 */
export function footprintRadius(P: HairParams, T: V3, up: V3, n: V3): number {
  let N = sub(up, mul(T, dot(up, T)))
  N = len(N) > 1e-3 ? norm(N) : perp(T)
  const B = cross(T, N)
  const tn = dot(T, n)
  const den = Math.abs(tn) < 0.1 ? 0.1 * (tn < 0 ? -1 : 1) : tn
  const fl = 1 + P.rootFlare / 100
  let r = 0
  for (const [a, b] of outline(P, 16)) {
    const o = add(mul(N, a * fl), mul(B, b * fl))
    const k = dot(o, n) / den
    r = Math.max(r, len(sub(o, mul(T, k))))
  }
  return r
}

/** Natural styled centerlines (no wall involved). Deterministic for a given seed. Roots whose footprint would overhang an edge are skipped. */
/** Extra room (mm) the collision pass keeps around a strand; the edge fit includes it so the two never disagree. */
export const COLLISION_CLEARANCE = 0.03

export function rawStrands(plan: Plan, P: HairParams, fit?: Fit): Raw[] {
  const live: number[] = []
  for (let i = 0; i < plan.count; i++) if (!plan.drop[i]) live.push(i)
  const L = P.length
  const depth0 = rootDepth(P)

  // clump seeds: strands converge on the tip of the nearest seed
  const K = Math.min(Math.round(P.clumpCount), live.length)
  const seeds: number[] = []
  if (K > 0 && P.clumpStrength > 0) {
    const r = rng(P.seed * 31 + 5)
    while (seeds.length < K) { const c = live[Math.floor(r() * live.length)]; if (!seeds.includes(c)) seeds.push(c) }
  }
  const tipOf = (i: number) => add(v3(plan.p, i), mul(v3(plan.dir, i), L))

  const out: Raw[] = []
  plan.edgeRejected = 0
  for (const i of live) {
    const R = rng(seedOf(P, i))
    const p = v3(plan.p, i), n = v3(plan.n, i), dir = v3(plan.dir, i)
    // bury the root along the strand: depth below the surface is rootDepth along the normal (never more than 60% of the body thickness)
    let depth = depth0
    const th = fit?.thickness?.(p, n)
    if (th !== undefined && Number.isFinite(th)) depth = Math.max(0.2, Math.min(depth, 0.6 * th))
    const sink = clamp(depth / Math.max(0.3, dot(dir, n)), 0.2, 3 * depth0)
    const start = sub(p, mul(dir, sink))
    const Lv = (L * (1 + (P.lengthVar / 100) * (R() * 2 - 1))) + sink

    let clump: V3 | null = null
    if (seeds.length) {
      let best = -1, bd = Infinity
      for (const sd of seeds) {
        const q = v3(plan.p, sd)
        const dd = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2
        if (dd < bd) { bd = dd; best = sd }
      }
      if (best !== i) {
        clump = mul(sub(tipOf(best), tipOf(i)), P.clumpStrength)
        if (P.printAware) clump = [clump[0], clump[1], 0]
      }
    }
    const poly = centerline(P, start, dir, n, Lv, R, clump)
    // the footprint at the surface (using the real first tangent, jitter included) must lie inside the region, plus the edge margin
    let T0: V3 = dir
    for (let k = 1; k < poly.length; k++) { const d = norm(sub(poly[k], poly[0])); if (d.some(Boolean)) { T0 = d; break } }
    const up: V3 = P.printAware ? [0, 0, 1] : n
    const fr = footprintRadius(P, T0, up, n) + COLLISION_CLEARANCE // the collision pass keeps this much space around the strand

    if (Math.abs(dot(T0, n)) < 0.1) { plan.edgeRejected++; continue }
    if (fit?.edges && fit.edges.nearest(p) < fr + fit.margin) { plan.edgeRejected++; continue }
    out.push({ i, poly, dir, n, start, len: Lv, clump, sink, exempt: sink + 2 * fr + 0.1, patch: plan.patch[i] })
  }
  return out
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
    if (pa) q = [q[0], q[1], start[2]] // print-aware: every sample stays in the root's layer
    out.push(q)
  }
  return out
}

const seedOf = (P: HairParams, i: number) => P.seed * 7919 + i * 104729 + 13

function pointAt(poly: V3[], arc: number[], s: number): V3 {
  let j = 1
  while (j < arc.length - 1 && arc[j] < s) j++
  const span = arc[j] - arc[j - 1] || 1
  return lerp(poly[j - 1], poly[j], clamp((s - arc[j - 1]) / span, 0, 1))
}

/** How far a strand tip is buried in the wall: at least half the wall thickness and one line width, but always inside the wall. */
export function tipOverlapOf(P: HairParams, wallThickness: number): number {
  return Math.min(Math.max(P.tipOverlap, 0.5 * wallThickness, P.nozzle * 1.05), 0.9 * wallThickness)
}

export interface Built { strands: Strand[]; dropped: number; redirected: number }

/** First wall hit along a polyline: truncates it at the hit and returns the contact (or null). */
function clipAt(poly: V3[], caster: Caster): { contact: V3; dn: V3; normal: V3 } | null {
  for (let j = 0; j + 1 < poly.length; j++) {
    const dv = sub(poly[j + 1], poly[j]), sl = len(dv)
    if (sl < 1e-9) continue
    const dn = mul(dv, 1 / sl)
    const h = caster.cast(poly[j], dn, sl)
    if (h) {
      const contact = add(poly[j], mul(dn, h.dist))
      poly.length = j + 1
      poly.push(contact)
      return { contact, dn, normal: h.normal }
    }
  }
  return null
}

/**
 * Finish the strands: with a wall every strand is terminated on it (clipped, extended, or - when its straight reach misses the wall -
 * bent onto the nearest wall point), then overlapped into it. Nothing is silently dropped for missing the wall.
 */
export function attachStrands(raws: Raw[], plan: Plan, P: HairParams, caster: Caster | null, wallThickness: number): Built {
  const toWall = P.lengthMode === 'toWall'
  let dropped = plan.drop.reduce((a, b) => a + b, 0)
  let redirected = 0
  const strands: Strand[] = []
  const overlap = tipOverlapOf(P, wallThickness)

  for (const r of raws) {
    let poly = r.poly
    let contact: V3 | null = null
    if (caster) {
      let hit = clipAt(poly, caster)
      if (!hit) {
        // straight extension along the final tangent
        const a = poly[poly.length - 2], b = poly[poly.length - 1]
        const dn = norm(sub(b, a))
        const reach = toWall ? 3 * P.length + 5 : Math.max(2, 0.6 * P.length)
        const ext: V3[] = [b, add(b, mul(dn, reach))]
        const h = clipAt(ext, caster)
        if (h) { hit = h; poly.push(ext[1]) }
      }
      if (!hit) {
        // bend the strand onto the nearest wall point (print-aware: the nearest one reachable horizontally)
        const tip = poly[poly.length - 1]
        let target: { point: V3; normal: V3 } | null = null
        if (P.printAware) {
          let best = Infinity
          for (let k = 0; k < 72; k++) {
            const ang = (k * Math.PI) / 36
            const d: V3 = [Math.cos(ang), Math.sin(ang), 0]
            const h = caster.cast(tip, d, 3 * P.length + 5)
            if (h && h.dist < best) { best = h.dist; target = { point: add(tip, mul(d, h.dist)), normal: h.normal } }
          }
        } else target = caster.closest(tip)
        if (!target) { dropped++; continue }
        redirected++
        const off = add(r.clump ?? [0, 0, 0], sub(target.point, tip))
        const R2 = rng(seedOf(P, r.i))
        R2() // same first draw as rawStrands (length variation) so jitter and styling match
        poly = centerline(P, r.start, r.dir, r.n, r.len, R2, off)
        hit = clipAt(poly, caster)
        if (!hit) {
          const dn = norm(sub(target.point, tip))
          poly.push(target.point)
          hit = { contact: target.point, dn: dn.some(Boolean) ? dn : r.dir, normal: target.normal }
        }
      }
      contact = hit.contact
      if (overlap > 0) {
        const into = mul(hit.normal, dot(hit.normal, hit.dn) > 0 ? 1 : -1) // face normal pointing into the wall
        const inN = mul(norm(into), 1)
        const c = dot(hit.dn, inN)
        const emb = c >= 0.5 ? hit.dn : norm(lerp(hit.dn, inN, 0.6))
        poly.push(add(contact, mul(emb, overlap))) // |tip - contact| = overlap, so the tip is never farther than that from the wall
      }
    }

    const arc = [0]
    for (let j = 1; j < poly.length; j++) arc.push(arc[j - 1] + len(sub(poly[j], poly[j - 1])))
    const total = arc[arc.length - 1]
    if (total < 1e-3) { dropped++; continue }
    const extra: number[] = []
    const fl = clamp(0.1 * total, 1, 4)
    // the buried root stays full size; taper and flare are measured from the surface crossing
    const rootArc = Math.min(r.sink, total * 0.9)
    if (P.rootFlare > 0) extra.push(rootArc + fl * 0.35, rootArc + fl * 0.8, rootArc + fl * 1.5)
    extra.push(rootArc)
    const svals = [...new Set([...arc, ...extra.filter((x) => x > 1e-3 && x < total - 1e-3)])].sort((x, y) => x - y)

    const pts = new Float32Array(svals.length * 3), scale = new Float32Array(svals.length)
    svals.forEach((s, k) => {
      pts.set(pointAt(poly, arc, s), k * 3)
      const so = Math.max(0, s - rootArc)
      let f = Math.max(0.15, 1 - (P.taper / 100) * (so / Math.max(1e-6, total - rootArc)))
      if (P.rootFlare > 0) f *= 1 + (P.rootFlare / 100) * Math.exp(-so / fl)
      scale[k] = f
    })
    strands.push({ pts, scale, up: P.printAware ? [0, 0, 1] : r.n, contact, tip: poly[poly.length - 1], rootArc, root: pointAt(poly, arc, rootArc), exempt: r.exempt, patch: r.patch })
  }
  return { strands, dropped, redirected }
}
