/**
 * Turns the outline a plane cuts out of a mesh (a polyline of hundreds of tiny segments) into real sketch curves: straight lines,
 * arcs and whole circles. Corners are found first; between two corners the points are fitted by a line, by one arc through both ends,
 * or the run is split where it strays most and each half is fitted again.
 */
import type { Imp } from '@/sketch/importers'
import type { Vec2 } from '@/sketch/types'

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Circle through three points, or null when they are (nearly) on a line. */
export function circle3(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-12) return null
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) }
}

/** Least squares circle (Kasa fit) of points. */
function fitCircle(pts: Vec2[]): { c: Vec2; r: number } | null {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0
  const n = pts.length
  for (const [x, y] of pts) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sz += z; sxz += x * z; syz += y * z }
  // solve [sxx sxy sx; sxy syy sy; sx sy n] [a b c] = [sxz syz sz]
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]]
  const rhs = [sxz, syz, sz]
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const D = det(M)
  if (Math.abs(D) < 1e-12) return null
  const col = (k: number) => M.map((row, i) => row.map((v, j) => (j === k ? rhs[i] : v)))
  const a = det(col(0)) / D, b = det(col(1)) / D, c = det(col(2)) / D
  const cx = a / 2, cy = b / 2
  const r = Math.sqrt(Math.max(0, c + cx * cx + cy * cy))
  return { c: [cx, cy], r }
}

const lineDev = (p: Vec2, a: Vec2, b: Vec2) => {
  const l = dist(a, b)
  if (l < 1e-12) return dist(p, a)
  return Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / l
}

function fitRun(run: Vec2[], tol: number, depth = 0): Imp[] {
  const a = run[0], b = run[run.length - 1]
  if (run.length === 2) return [{ k: 'line', a, b }]
  let worst = 0, wi = 1
  for (let i = 1; i < run.length - 1; i++) { const d = lineDev(run[i], a, b); if (d > worst) { worst = d; wi = i } }
  if (worst <= tol) return [{ k: 'line', a, b }]
  // one arc through both ends and the middle of the run
  if (run.length >= 5 && depth < 12) {
    const mid = run[Math.floor(run.length / 2)]
    const cc = circle3(a, mid, b)
    if (cc && cc.r < 1e6) {
      let dev = 0
      for (const p of run) dev = Math.max(dev, Math.abs(dist(p, cc.c) - cc.r))
      if (dev <= tol) {
        // counter-clockwise from the start: which way the run turns decides which end is the start
        const cross = (mid[0] - a[0]) * (b[1] - a[1]) - (mid[1] - a[1]) * (b[0] - a[0])
        const ccw = cross > 0
        const s = ccw ? a : b, e = ccw ? b : a
        const a0 = Math.atan2(s[1] - cc.c[1], s[0] - cc.c[0])
        let a1 = Math.atan2(e[1] - cc.c[1], e[0] - cc.c[0])
        while (a1 <= a0) a1 += Math.PI * 2
        if (a1 - a0 < Math.PI * 1.9) return [{ k: 'arc', c: cc.c, r: cc.r, a0, a1 }]
      }
    }
  }
  if (depth > 40) return [{ k: 'line', a, b }]
  return [...fitRun(run.slice(0, wi + 1), tol, depth + 1), ...fitRun(run.slice(wi), tol, depth + 1)]
}

/** Fit one outline (plane-local points) with lines, arcs and circles. Closed outlines come back as a chain that ends where it began. */
export function fitLoop(pts: Vec2[], closed: boolean, tol: number): Imp[] {
  if (pts.length < 2) return []
  const P = closed ? [...pts] : pts
  if (closed && P.length < 3) return []
  const n = P.length
  // a whole circle: every point within the tolerance of one circle all the way round
  if (closed && n >= 8) {
    const f = fitCircle(P)
    if (f && f.r > tol * 4) {
      let dev = 0
      for (const p of P) dev = Math.max(dev, Math.abs(dist(p, f.c) - f.r))
      if (dev <= tol) return [{ k: 'circle', c: f.c, r: f.r }]
    }
  }
  // corners: where the outline turns more than 35 degrees
  const turn = (i: number) => {
    const a = P[(i + n - 1) % n], b = P[i], c = P[(i + 1) % n]
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]]
    const l = Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1])
    return l < 1e-18 ? 0 : Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / l)))
  }
  const lim = (35 * Math.PI) / 180
  const corners: number[] = []
  for (let i = 0; i < n; i++) { if (!closed && (i === 0 || i === n - 1)) { corners.push(i); continue } if (turn(i) > lim) corners.push(i) }
  const out: Imp[] = []
  if (!corners.length) {
    // smooth all the way round: break where the outline goes from straight to curved, else at the point farthest from the start
    const straight = (i: number) => turn(i) < (1.2 * Math.PI) / 180
    for (let i = 0; i < n; i++) { const was = straight((i + n - 1) % n), is = straight(i); if (was && !is) corners.push(i); else if (!was && is) corners.push((i + n - 1) % n) }
    corners.sort((a, b) => a - b)
    if (corners.length < 2) { corners.length = 0; let far = 1, fd = 0; for (let i = 1; i < n; i++) { const d = dist(P[i], P[0]); if (d > fd) { fd = d; far = i } } corners.push(0, far) }
  }
  const span = closed ? corners.length : corners.length - 1
  for (let k = 0; k < span; k++) {
    const s = corners[k], e = corners[(k + 1) % corners.length]
    const run: Vec2[] = []
    for (let i = s; ; i = (i + 1) % n) { run.push(P[i]); if (i === e) break; if (run.length > n + 1) break }
    if (run.length >= 2) out.push(...fitRun(run, tol))
  }
  return out
}

/** Points along a fitted shape, for drawing the preview. */
export function shapePoints(s: Imp): Vec2[] {
  if (s.k === 'line') return [s.a, s.b]
  if (s.k === 'circle' || s.k === 'arc') {
    const a0 = s.k === 'arc' ? s.a0 : 0, a1 = s.k === 'arc' ? s.a1 : Math.PI * 2
    const n = Math.max(8, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 72))
    return Array.from({ length: n + 1 }, (_, i): Vec2 => [s.c[0] + s.r * Math.cos(a0 + ((a1 - a0) * i) / n), s.c[1] + s.r * Math.sin(a0 + ((a1 - a0) * i) / n)])
  }
  return []
}
