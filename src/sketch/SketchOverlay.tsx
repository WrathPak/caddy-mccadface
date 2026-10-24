/** Viewport overlay for sketch mode: plane grid, geometry, profiles, drafts, snaps, constraint glyphs, dimensions, input. */
import './sketch.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Html, Line } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Matrix4, MathUtils, OrthographicCamera, PerspectiveCamera, Plane, Raycaster,
  Vector2, Vector3, type Mesh, type ShaderMaterial,
} from 'three'
import { useVpColors } from '@/viewport/colors'
import { viewportBus } from '@/viewport/bus'
import { dimText, layoutDim } from './dims'
import { curvePoints, entityPolylines, profileGeometry } from './draw'
import { circumcircle, arcInfo, cross, dist, perp, polar, sampleArc, sub, TAU } from './geom'
import { circleOf, entityById, lineEnds, pos } from './model'
import { previewPolys } from './offsetTool'
import { fieldsFor, liveValues, resolveEnd, valuesOf, hasText, arcThrough, type DrawTool, type Typed } from './typed'
import { planeQuaternion, toLocal } from './plane'
import { type Snap } from './snap'
import { GRID_GLSL, gridFadeRange, gridLevels } from '@/viewport/gridMath'
import {
  applyDimEdit, cancelDimEdit, doubleClick, editDim, pointerDown, pointerMove, pointerUp, select, setWpp, typedKey, useSketch, type SketchState,
} from './store'
import { isDim, type Constraint, type SketchModel, type Vec2 } from './types'

const Z = 0.02

// ---------------------------------------------------------------- colors

const read = (n: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb
function useSketchColors() {
  const c = useVpColors()
  return useMemo(
    () => ({
      free: c.accent, fixed: read('--text', '#d4d7dc'), sel: read('--warn', '#d2a24a'), hover: read('--accent-hover', '#78c4d3'),
      cons: read('--text-faint', '#636973'), dim: read('--text-dim', '#9096a0'), ref: read('--text-dim', '#9096a0'), danger: read('--danger', '#d9625a'), grid: c.grid, major: c.gridMajor,
      axisX: c.axisX, axisY: c.axisY,
    }),
    [c],
  )
}

// ---------------------------------------------------------------- world-per-pixel

/** Local units per screen pixel at the sketch plane; re-renders the caller when it changes by >3%. */
function useWpp(): number {
  const [w, setW] = useState(1)
  const last = useRef(1)
  useFrame((state) => {
    const v = wppFor(state.camera, state.size.height, useSketch.getState().plane)
    setWpp(v)
    if (Math.abs(v - last.current) / last.current > 0.03) { last.current = v; setW(v) }
  })
  return w
}
function wppFor(cam: PerspectiveCamera | OrthographicCamera | { isOrthographicCamera?: boolean }, height: number, plane: SketchState['plane']): number {
  const c = cam as PerspectiveCamera & OrthographicCamera
  if (c.isOrthographicCamera) return 1 / c.zoom
  const d = Math.abs((c.position.x - plane.origin[0]) * plane.normal[0] + (c.position.y - plane.origin[1]) * plane.normal[1] + (c.position.z - plane.origin[2]) * plane.normal[2])
  return (2 * Math.max(d, 0.01) * Math.tan(MathUtils.degToRad(c.fov) / 2)) / height
}

const v3 = (p: Vec2, z = Z): [number, number, number] => [p[0], p[1], z]

// ---------------------------------------------------------------- grid

const gridVert = /* glsl */ `
varying vec2 vLocal;
varying vec3 vEye;
uniform vec2 uCenter;
uniform float uHalf;
void main() {
  vLocal = position.xy * uHalf + uCenter;
  vec4 mv = modelViewMatrix * vec4(vLocal, 0.0, 1.0);
  vEye = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`
const gridFrag = /* glsl */ `
varying vec2 vLocal;
varying vec3 vEye;
uniform float uStep;
uniform float uBlend;
uniform vec2 uCenter;
uniform float uHalf;
uniform float uOrtho;
uniform float uFadeA;
uniform float uFadeB;
uniform vec3 uMinor;
uniform vec3 uMajor;
uniform vec3 uAxisX;
uniform vec3 uAxisY;
${GRID_GLSL}
void main() {
  vec2 p = vLocal;
  // fade with distance from the camera (depth when orthographic), so a tilted sketch plane never ends in a visible edge
  float d = uOrtho > 0.5 ? -vEye.z : length(vEye);
  float f = (1.0 - smoothstep(uFadeA, uFadeB, d)) * (1.0 - smoothstep(uHalf * 0.55, uHalf, length(p - uCenter)));
  float k = gridStrength(p, uStep, uBlend, f);
  vec3 col = gridColor(k, uMinor, uMajor);
  float a = 0.85 * k;
  vec2 ad = fwidth(p) * 1.2;
  float ax = 1.0 - min(abs(p.y) / max(ad.y, 1e-6), 1.0);
  float ay = 1.0 - min(abs(p.x) / max(ad.x, 1e-6), 1.0);
  if (ax > 0.0) { col = uAxisX; a = max(a, ax * 0.95 * f); }
  if (ay > 0.0) { col = uAxisY; a = max(a, ay * 0.95 * f); }
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`

function SketchGrid() {
  const colors = useVpColors()
  const mesh = useRef<Mesh>(null)
  const mat = useRef<ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({ uStep: { value: 10 }, uBlend: { value: 0 }, uHalf: { value: 500 }, uOrtho: { value: 0 }, uFadeA: { value: 1e5 }, uFadeB: { value: 2e5 }, uCenter: { value: new Vector2() }, uMinor: { value: new Color() }, uMajor: { value: new Color() }, uAxisX: { value: new Color() }, uAxisY: { value: new Color() } }),
    [],
  )
  const ray = useMemo(() => new Raycaster(), [])
  useFrame((state) => {
    const u = mat.current?.uniforms
    if (!u) return
    u.uMinor.value.set(colors.grid)
    u.uMajor.value.set(colors.gridMajor)
    u.uAxisX.value.set(colors.axisX)
    u.uAxisY.value.set(colors.axisY)
    const plane = useSketch.getState().plane
    const wpp = wppFor(state.camera, state.size.height, plane)
    const { step, blend } = gridLevels(wpp)
    u.uStep.value = step
    u.uBlend.value = blend
    // a tilted plane shows more of itself: widen the quad by how obliquely we look at it, up to where the grid has faded anyway
    const cam = state.camera as PerspectiveCamera & OrthographicCamera
    const ortho = !!cam.isOrthographicCamera
    const dir = cam.getWorldDirection(new Vector3())
    const tilt = Math.max(Math.abs(dir.x * plane.normal[0] + dir.y * plane.normal[1] + dir.z * plane.normal[2]), 0.1)
    u.uHalf.value = (Math.max(state.size.width, state.size.height) * wpp * 1.1) / tilt
    const range = gridFadeRange(cam.far || 50000, ortho)
    u.uFadeA.value = range.start
    u.uFadeB.value = range.end
    u.uOrtho.value = ortho ? 1 : 0
    // the quad follows the view; the lines themselves are fixed to the sketch origin (multiples of the step), so nothing swims
    ray.setFromCamera(new Vector2(0, 0), state.camera)
    const hit = new Vector3()
    const pl = new Plane().setFromNormalAndCoplanarPoint(new Vector3(...plane.normal), new Vector3(...plane.origin))
    if (ray.ray.intersectPlane(pl, hit)) {
      const l = toLocal(plane, [hit.x, hit.y, hit.z])
      u.uCenter.value.set(l[0], l[1])
    }
  })
  return (
    <mesh ref={mesh} renderOrder={-1} raycast={() => null} frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial ref={mat} vertexShader={gridVert} fragmentShader={gridFrag} uniforms={uniforms as never as ShaderMaterial['uniforms']} transparent depthWrite={false} side={DoubleSide} />
    </mesh>
  )
}

// ---------------------------------------------------------------- geometry

export function Segments({ pairs, color, width, dashed, wpp, order = 10 }: { pairs: Vec2[]; color: string; width: number; dashed?: boolean; wpp: number; order?: number }) {
  const key = pairs.length + ':' + pairs.reduce((a, p) => a + p[0] * 1.31 + p[1] * 2.17, 0)
  const pts = useMemo(() => pairs.map((p) => v3(p)), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  if (pts.length < 2) return null
  return <Line segments points={pts} color={color} lineWidth={width} dashed={dashed} dashSize={wpp * 6} gapSize={wpp * 4} depthTest={false} transparent renderOrder={order} raycast={() => null} />
}

export const toPairs = (pts: Vec2[], closed = false): Vec2[] => {
  const out: Vec2[] = []
  for (let i = 0; i + 1 < pts.length; i++) out.push(pts[i], pts[i + 1])
  if (closed && pts.length > 2) out.push(pts[pts.length - 1], pts[0])
  return out
}

function Dots({ pts, color, size, order = 12 }: { pts: Vec2[]; color: string; size: number; order?: number }) {
  const geo = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pts.flatMap((p) => [p[0], p[1], Z])), 3))
    return g
  }, [pts])
  useEffect(() => () => geo.dispose(), [geo])
  if (!pts.length) return null
  return (
    <points geometry={geo} renderOrder={order} frustumCulled={false} raycast={() => null}>
      <pointsMaterial color={color} size={size} sizeAttenuation={false} depthTest={false} transparent />
    </points>
  )
}

function Geometry({ wpp }: { wpp: number }) {
  const c = useSketchColors()
  const model = useSketch((s) => s.model)
  const info = useSketch((s) => s.info)
  const sel = useSketch((s) => s.sel)
  const hover = useSketch((s) => s.hover)
  const picks = useSketch((s) => s.picks)

  const groups = useMemo(() => {
    const g: Record<'free' | 'fixed' | 'sel' | 'hover' | 'cons' | 'ref' | 'broken', Vec2[]> = { free: [], fixed: [], sel: [], hover: [], cons: [], ref: [], broken: [] }
    for (const pl of entityPolylines(model)) {
      const cls = sel.includes(pl.id) || picks.includes(pl.id) ? 'sel' : hover === pl.id ? 'hover' : pl.broken ? 'broken' : pl.ref ? 'ref' : pl.construction ? 'cons' : info.fixed.has(pl.id) ? 'fixed' : 'free'
      g[cls].push(...toPairs(pl.pts))
    }
    return g
  }, [model, info, sel, hover, picks])

  const dots = useMemo(() => {
    const d: Record<'free' | 'fixed' | 'sel' | 'hover' | 'ref' | 'broken', Vec2[]> = { free: [], fixed: [], sel: [], hover: [], ref: [], broken: [] }
    for (const e of model.entities) {
      if (e.type !== 'point') continue
      const cls = sel.includes(e.id) || picks.includes(e.id) ? 'sel' : hover === e.id ? 'hover' : e.broken ? 'broken' : e.ref ? 'ref' : info.fixed.has(e.id) ? 'fixed' : 'free'
      d[cls].push([e.x, e.y])
    }
    return d
  }, [model, info, sel, hover, picks])

  return (
    <>
      <Segments pairs={groups.cons} color={c.cons} width={1.4} dashed wpp={wpp} />
      <Segments pairs={groups.ref} color={c.ref} width={1.6} wpp={wpp} />
      <Segments pairs={groups.broken} color={c.danger} width={2.2} wpp={wpp} order={12} />
      <Segments pairs={groups.free} color={c.free} width={1.8} wpp={wpp} />
      <Segments pairs={groups.fixed} color={c.fixed} width={1.8} wpp={wpp} />
      <Segments pairs={groups.hover} color={c.hover} width={2.8} wpp={wpp} order={13} />
      <Segments pairs={groups.sel} color={c.sel} width={2.8} wpp={wpp} order={14} />
      <Dots pts={dots.free} color={c.free} size={6} />
      <Dots pts={dots.fixed} color={c.fixed} size={6} />
      <Dots pts={dots.ref} color={c.ref} size={5} />
      <Dots pts={dots.broken} color={c.danger} size={6} order={12} />
      <Dots pts={dots.hover} color={c.hover} size={9} order={15} />
      <Dots pts={dots.sel} color={c.sel} size={9} order={16} />
      <Dots pts={[[0, 0]]} color={info.fixed.size ? c.fixed : c.dim} size={7} order={11} />
    </>
  )
}

function ProfileFills() {
  const profiles = useSketch((s) => s.profiles)
  const colors = useVpColors()
  const geos = useMemo(() => profiles.map((p) => profileGeometry(p)), [profiles])
  useEffect(() => () => geos.forEach((g) => g.dispose()), [geos])
  return (
    <group position={[0, 0, 0]}>
      {geos.map((g, i) => (
        <mesh key={i} geometry={g} renderOrder={1} raycast={() => null}>
          <meshBasicMaterial color={colors.accent} transparent opacity={0.13} depthTest={false} depthWrite={false} side={DoubleSide} />
        </mesh>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------- draft & snap preview

interface Preview { lines: Vec2[][]; /** where the next point is going */ end: Vec2; stage: number; live: Partial<Record<string, number>> }

/** The geometry the active drawing tool would create at the cursor, honouring typed values. */
function draftPreview(d: SketchState['draft'], cur: Snap | null, typed: Typed | null): Preview | null {
  if (!d || !cur) return null
  const tool = d.tool as DrawTool
  const stage = d.tool === 'arc' ? Math.max(0, d.pts.length - 1) : 0
  const vals = valuesOf(typed && typed.tool === d.tool && typed.stage === stage ? typed : null)
  const typedNow = Object.keys(vals).length > 0
  const p = typedNow || d.tool === 'arc' ? resolveEnd(tool, stage, d.pts, cur.pos, vals) : cur.pos
  switch (d.tool) {
    case 'line': {
      const a = d.pts[d.pts.length - 1]
      return { lines: [[a, p]], end: p, stage, live: liveValues('line', 0, d.pts, p) }
    }
    case 'rect':
    case 'rectC': {
      const [x0, y0] = d.pts[0], [x1, y1] = p
      const ax = d.tool === 'rect' ? x0 : x0 - (x1 - x0), ay = d.tool === 'rect' ? y0 : y0 - (y1 - y0)
      return { lines: [[[ax, ay], [x1, ay], [x1, y1], [ax, y1], [ax, ay]]], end: p, stage, live: liveValues(d.tool, 0, d.pts, p) }
    }
    case 'circle': {
      const r = dist(d.pts[0], p)
      const pts: Vec2[] = []
      for (let i = 0; i <= 96; i++) pts.push(polar(d.pts[0], r, (i / 96) * TAU))
      return { lines: [pts, [d.pts[0], p]], end: p, stage, live: liveValues('circle', 0, d.pts, p) }
    }
    case 'arc': {
      if (d.pts.length === 1) return { lines: [[d.pts[0], p]], end: p, stage, live: liveValues('arc', 0, d.pts, p) }
      const [p1, p2] = d.pts
      const third = arcThrough(p1, p2, cur.pos, vals.rad)
      const cc = circumcircle(p1, p2, third)
      if (!cc) return { lines: [[p1, p2]], end: third, stage, live: {} }
      const ccw = cross(sub(third, p1), sub(p2, third)) > 0
      const i = ccw ? arcInfo(cc.c, p1, p2) : arcInfo(cc.c, p2, p1)
      const pts = [ccw ? p1 : p2, ...sampleArc(cc.c, i.r, i.a0, i.a1, Math.PI / 48)]
      return { lines: [pts], end: third, stage, live: { rad: cc.r } }
    }
    default: return null
  }
}

const KIND_TEXT: Record<string, string> = { point: 'Endpoint', origin: 'Origin', center: 'Center', mid: 'Midpoint', on: 'On curve', axis: 'On axis' }

function snapHint(s: Snap): string | null {
  if (KIND_TEXT[s.kind]) return KIND_TEXT[s.kind]
  if (s.h) return 'Horizontal'
  if (s.v) return 'Vertical'
  return null
}

function Marker({ snap, wpp }: { snap: Snap; wpp: number }) {
  const c = useSketchColors()
  const r = wpp * 6
  const [x, y] = snap.pos
  const shapes: Vec2[][] = []
  switch (snap.kind) {
    case 'point': case 'origin': shapes.push([[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r], [x - r, y - r]]); break
    case 'center': { const pts: Vec2[] = []; for (let i = 0; i <= 24; i++) pts.push(polar([x, y], r, (i / 24) * TAU)); shapes.push(pts); break }
    case 'mid': shapes.push([[x - r, y - r], [x + r, y - r], [x, y + r], [x - r, y - r]]); break
    case 'on': shapes.push([[x - r, y - r], [x + r, y + r]], [[x - r, y + r], [x + r, y - r]]); break
    case 'axis': shapes.push([[x - r, y], [x, y + r], [x + r, y], [x, y - r], [x - r, y]]); break
    default: shapes.push([[x - r * 0.5, y], [x + r * 0.5, y]], [[x, y - r * 0.5], [x, y + r * 0.5]])
  }
  const hint = snapHint(snap)
  return (
    <>
      {snap.guides.map((g, i) => (
        <Line key={i} points={[v3(g.from), v3(g.to)]} color={c.sel} lineWidth={1} dashed dashSize={wpp * 5} gapSize={wpp * 4} depthTest={false} transparent opacity={0.8} renderOrder={9} raycast={() => null} />
      ))}
      {shapes.map((pts, i) => (
        <Line key={'m' + i} points={pts.map((p) => v3(p, Z + 0.01))} color={c.sel} lineWidth={1.6} depthTest={false} transparent renderOrder={20} raycast={() => null} />
      ))}
      {hint && (
        <Html position={v3(snap.pos)} zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
          <div className="sk-hint">{hint}</div>
        </Html>
      )}
    </>
  )
}

const fmt = (v: number | undefined, unit: string) => (v === undefined ? '' : (unit === 'deg' ? `${(+v.toFixed(2))}°` : `${(+v.toFixed(2))}`))

/** The boxes for typed values: live numbers until you type, then what you typed. Tab moves between them. */
function TypedInputs({ at, fields, active, live }: { at: Vec2; fields: Typed['fields']; active: number; live: Partial<Record<string, number>> }) {
  return (
    <Html position={v3(at)} zIndexRange={[32, 0]} style={{ pointerEvents: 'none' }}>
      <div className="sk-typed">
        {fields.map((f, i) => (
          <div key={f.key} className="sk-field" data-active={i === active} data-typed={f.text !== ''}>
            <span className="lbl">{f.label}</span>
            <span className="val">{f.text !== '' ? f.text : fmt(live[f.key], f.unit)}{i === active && <i className="caret" />}</span>
          </div>
        ))}
        {fields.length > 1 && <div className="sk-keys">Tab next · Enter place</div>}
      </div>
    </Html>
  )
}

function Draft({ wpp }: { wpp: number }) {
  const c = useSketchColors()
  const draft = useSketch((s) => s.draft)
  const cursor = useSketch((s) => s.cursor)
  const typed = useSketch((s) => s.typed)
  const prev = useMemo(() => draftPreview(draft, cursor, typed), [draft, cursor, typed])
  if (!prev || !draft) return null
  const tool = draft.tool as DrawTool
  const stage = draft.tool === 'arc' ? Math.max(0, draft.pts.length - 1) : 0
  const fields = typed && typed.tool === draft.tool && typed.stage === stage ? typed : { fields: fieldsFor(tool, stage), active: 0, tool: draft.tool, stage }
  return (
    <>
      {prev.lines.map((pts, i) => (
        <Line key={i} points={pts.map((p) => v3(p))} color={c.free} lineWidth={1.8} dashed dashSize={wpp * 6} gapSize={wpp * 3} depthTest={false} transparent renderOrder={18} raycast={() => null} />
      ))}
      <TypedInputs at={prev.end} fields={fields.fields} active={fields.active} live={prev.live} />
    </>
  )
}

/** Trim: the piece under the cursor that a click would remove. */
function TrimPreview({ wpp }: { wpp: number }) {
  const c = useSketchColors()
  const poly = useSketch((s) => s.trimHover)
  if (!poly || poly.length < 2) return null
  return <Segments pairs={toPairs(poly)} color={c.danger} width={3.2} wpp={wpp} order={19} />
}

/** Offset: the curves that a click would create, and the distance box. */
function OffsetPreview({ wpp }: { wpp: number }) {
  const c = useSketchColors()
  const model = useSketch((s) => s.model)
  const offset = useSketch((s) => s.offset)
  const typed = useSketch((s) => s.typed)
  const cursor = useSketch((s) => s.cursor)
  const polys = useMemo(() => (offset ? previewPolys(model, offset.chain, offset.d) : []), [model, offset])
  if (!offset) return null
  const f = typed && typed.tool === 'offset' ? typed : { fields: fieldsFor('offset'), active: 0, tool: 'offset', stage: 0 }
  return (
    <>
      {polys.map((pts, i) => <Segments key={i} pairs={toPairs(pts)} color={c.free} width={2} dashed wpp={wpp} order={18} />)}
      {cursor && <TypedInputs at={cursor.pos} fields={f.fields} active={f.active} live={{ dist: Math.abs(offset.d) }} />}
    </>
  )
}

function SelectionBox() {
  const box = useSketch((s) => s.box)
  const c = useSketchColors()
  if (!box) return null
  const [a, b] = box
  return <Line points={[v3(a), v3([b[0], a[1]]), v3(b), v3([a[0], b[1]]), v3(a)]} color={c.free} lineWidth={1} dashed dashSize={0.5} gapSize={0.5} depthTest={false} transparent renderOrder={18} raycast={() => null} />
}

// ---------------------------------------------------------------- constraint glyphs

const GLYPH: Partial<Record<Constraint['type'], string>> = {
  horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥', equal: '=', tangent: 'T', tangentAt: 'T', midpoint: 'M', fix: '■',
  pointOnLine: '○', pointOnCurve: '○', onAxis: '○', coincident: '◉',
}

function anchorOf(m: SketchModel, id: string): Vec2 | null {
  const e = entityById(m, id)
  if (id === 'O') return [0, 0]
  if (!e) return null
  if (e.type === 'point') return [e.x, e.y]
  if (e.type === 'line') { const [a, b] = lineEnds(m, e); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }
  if (e.type === 'circle') { const { c, r } = circleOf(m, e); return [c[0], c[1] + r] }
  const i = arcInfo(pos(m, e.c), pos(m, e.s), pos(m, e.e))
  return polar(pos(m, e.c), i.r, i.a0 + (i.a1 - i.a0) / 2)
}

function Glyphs() {
  const model = useSketch((s) => s.model)
  const sel = useSketch((s) => s.sel)
  const clusters = useMemo(() => {
    const map = new Map<string, { at: Vec2; items: Constraint[] }>()
    for (const c of model.constraints) {
      if (isDim(c) || !GLYPH[c.type]) continue
      const targets = c.type === 'pointOnLine' || c.type === 'pointOnCurve' || c.type === 'midpoint' || c.type === 'coincident' ? [c.refs[0]] : c.type === 'tangentAt' ? [c.refs[2]] : c.refs
      for (const t of targets) {
        const at = anchorOf(model, t)
        if (!at) continue
        const k = (map.get(t) ?? map.set(t, { at, items: [] }).get(t)!)
        if (!k.items.includes(c)) k.items.push(c)
      }
    }
    return [...map.entries()]
  }, [model])
  return (
    <>
      {clusters.map(([id, k]) => (
        <Html key={id} position={v3(k.at)} zIndexRange={[15, 0]} style={{ pointerEvents: 'none' }}>
          <div className="sk-glyphs">
            {k.items.map((c) => (
              <span key={c.id} className="sk-glyph" data-sel={sel.includes(c.id)} onPointerDown={(e) => { e.stopPropagation(); select([c.id], e.shiftKey) }}>{GLYPH[c.type]}</span>
            ))}
          </div>
        </Html>
      ))}
    </>
  )
}

// ---------------------------------------------------------------- dimensions

function DimInput({ c }: { c: Constraint }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const [bad, setBad] = useState(false)
  useEffect(() => { ref.current?.focus(); ref.current?.select() }, [])
  const commit = () => {
    if (done.current) return
    const ok = applyDimEdit(c.id, ref.current?.value ?? '')
    if (ok) done.current = true
    else { setBad(true); setTimeout(() => setBad(false), 500); ref.current?.focus() }
  }
  return (
    <input
      ref={ref}
      className={'sk-dim-input' + (bad ? ' err' : '')}
      defaultValue={c.expr ?? String(c.value ?? 0)}
      spellCheck={false}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') { done.current = true; cancelDimEdit() }
      }}
      onBlur={() => { if (!done.current) commit() }}
    />
  )
}

function Dimensions({ wpp }: { wpp: number }) {
  const c = useSketchColors()
  const model = useSketch((s) => s.model)
  const info = useSketch((s) => s.info)
  const placing = useSketch((s) => s.placing)
  const edit = useSketch((s) => s.dimEdit)
  const sel = useSketch((s) => s.sel)
  const bad = useSketch((s) => s.badDims)
  const list = useMemo(() => {
    const l = model.constraints.filter((k) => isDim(k) && !k.hidden)
    return placing ? [...l, placing] : l
  }, [model, placing])
  return (
    <>
      {list.map((k) => {
        const lay = layoutDim(model, k, wpp * 4)
        if (!lay) return null
        const selected = sel.includes(k.id)
        const col = info.conflicts.includes(k.id) || bad.includes(k.id) ? c.danger : selected ? c.sel : k.id === '~preview' ? c.free : c.dim
        const s = wpp * 9
        const heads: Vec2[] = []
        for (const a of lay.arrows) {
          const n = perp(a.dir)
          const base: Vec2 = [a.tip[0] + a.dir[0] * s, a.tip[1] + a.dir[1] * s]
          heads.push(a.tip, [base[0] + n[0] * s * 0.32, base[1] + n[1] * s * 0.32], a.tip, [base[0] - n[0] * s * 0.32, base[1] - n[1] * s * 0.32])
        }
        return (
          <group key={k.id}>
            <Segments pairs={lay.lines.flatMap((p) => toPairs(p))} color={col} width={1.1} wpp={wpp} order={8} />
            <Segments pairs={heads} color={col} width={1.4} wpp={wpp} order={8} />
            <Html position={v3(lay.label)} center zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
              {edit === k.id ? (
                <DimInput c={k} />
              ) : (
                <span
                  className="sk-dim"
                  data-sel={selected}
                  data-bad={col === c.danger}
                  data-preview={k.id === '~preview'}
                  onPointerDown={(e) => { e.stopPropagation(); if (k.id !== '~preview') select([k.id], e.shiftKey) }}
                  onDoubleClick={(e) => { e.stopPropagation(); if (k.id !== '~preview') editDim(k.id) }}
                >
                  {dimText(k)}
                </span>
              )}
            </Html>
          </group>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------- input

function InputController() {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const el = gl.domElement
    const ray = new Raycaster()
    const ndc = new Vector2()
    const hit = new Vector3()
    const pl = new Plane()
    const locate = (e: PointerEvent | MouseEvent) => {
      const { plane } = useSketch.getState()
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      pl.setFromNormalAndCoplanarPoint(new Vector3(...plane.normal), new Vector3(...plane.origin))
      if (!ray.ray.intersectPlane(pl, hit)) return null
      return { p: toLocal(plane, [hit.x, hit.y, hit.z]), wpp: wppFor(camera as PerspectiveCamera, r.height, plane) }
    }
    const mods = (e: PointerEvent | MouseEvent) => ({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey })
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || !useSketch.getState().active) return
      const l = locate(e)
      if (!l) return
      el.setPointerCapture(e.pointerId)
      pointerDown(l.p, l.wpp, mods(e), [e.clientX, e.clientY])
    }
    const move = (e: PointerEvent) => {
      if (!useSketch.getState().active) return
      const l = locate(e)
      if (l) pointerMove(l.p, l.wpp, mods(e))
    }
    const up = (e: PointerEvent) => {
      if (e.button !== 0 || !useSketch.getState().active) return
      const l = locate(e)
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
      if (l) pointerUp(l.p, l.wpp, mods(e))
    }
    const dbl = (e: MouseEvent) => {
      if (!useSketch.getState().active) return
      const l = locate(e)
      if (l) doubleClick(l.p, l.wpp)
    }
    // typed values (digits, Tab, Enter, Backspace) while a draft or offset is open; capture phase so the global
    // shortcut handler never sees keys that belong to a field
    const key = (e: KeyboardEvent) => {
      if (!useSketch.getState().active) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (typedKey(e)) { e.preventDefault(); e.stopPropagation() }
    }
    window.addEventListener('keydown', key, true)
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('dblclick', dbl)
    const off = viewportBus.on('redraw', () => invalidate())
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('dblclick', dbl)
      window.removeEventListener('keydown', key, true)
      off()
    }
  }, [gl, camera, invalidate])

  const tool = useSketch((s) => s.tool)
  useEffect(() => {
    gl.domElement.style.cursor = tool === 'select' ? 'default' : 'crosshair'
    return () => { gl.domElement.style.cursor = '' }
  }, [gl, tool])
  return null
}

// ---------------------------------------------------------------- root

/** Mounted in the Scene; renders nothing unless a sketch is being edited. */
export function SketchOverlay() {
  const active = useSketch((s) => s.active)
  const plane = useSketch((s) => s.plane)
  const cursor = useSketch((s) => s.cursor)
  const wpp = useWpp()
  const q = useMemo(() => planeQuaternion(plane), [plane])
  if (!active) return null
  return (
    <group position={plane.origin} quaternion={q}>
      <SketchGrid />
      <ProfileFills />
      <Geometry wpp={wpp} />
      <Glyphs />
      <Dimensions wpp={wpp} />
      <Draft wpp={wpp} />
      <TrimPreview wpp={wpp} />
      <OffsetPreview wpp={wpp} />
      <SelectionBox />
      {cursor && <Marker snap={cursor} wpp={wpp} />}
      <InputController />
    </group>
  )
}
