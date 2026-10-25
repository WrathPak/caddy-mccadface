/** Viewport overlays of the assembly: component origins, joint glyphs, snap points, explode trails, interference and clearance. */
import { useEffect, useMemo } from 'react'
import { Html, Line } from '@react-three/drei'
import { BufferAttribute, BufferGeometry, DoubleSide } from 'three'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import type { Vec3 } from '@/kernel/types'
import { useSceneHalfSize } from '@/viewport/Origin'
import { useVpColors } from '@/viewport/colors'
import { explodeOffsets, placeAssembly } from './instances'
import { add, frameMatrix, isIdentity, multiply, point, type Mat4 } from './matrix'
import { useInstances, usePlacement } from './place'
import { useAssemblyRuntime } from './runtime'
import { SNAP_LABEL, snapPoints } from './snaps'
import { originMatrix, staticMatrix } from './joints'

const KIND_COLOR: Record<string, string> = { face: '#7fb3ff', edgeMid: '#e0b050', circle: '#6dd0a0', vertex: '#e07fd0' }

/** World size for glyphs: a fraction of the scene, so they read at any model scale. */
function useGlyphSize(): number {
  const s = useSceneHalfSize()
  return Math.max(1.2, s * 0.045)
}

const axisPts = (m: Mat4, len: number): Vec3[][] => [
  [point(m, [0, 0, 0]), point(m, [len, 0, 0])],
  [point(m, [0, 0, 0]), point(m, [0, len, 0])],
  [point(m, [0, 0, 0]), point(m, [0, 0, len])],
]

/** A small axis triad at the origin of every component that is not sitting at the document origin. */
function ComponentOrigins() {
  const place = usePlacement()
  const active = useDoc((s) => s.activeOcc)
  const hidden = useUi((s) => s.hiddenIds)
  const show = useUi((s) => s.showOrigin)
  const c = useVpColors()
  const size = useGlyphSize()
  if (!show) return null
  const cols = [c.axisX, c.axisY, c.axisZ]
  return (
    <group name="component-origins">
      {place.nodes.filter((n) => n.id !== active && !isIdentity(place.worlds[n.id]) && !n.id.split('/').some((p) => hidden[p])).map((n) => (
        <group key={n.id}>
          {axisPts(place.worlds[n.id], size * 1.4).map((p, i) => <Line key={i} points={p} color={cols[i]} lineWidth={1.5} raycast={() => null} />)}
        </group>
      ))}
    </group>
  )
}

/** A joint's glyph: a ring about its axis with the axis drawn out, at the first origin; a thin line to the second origin when they are apart. */
function JointGlyph({ id, worldA, worldB, frameA, frameB, error, selected, size }: { id: string; worldA: Mat4; worldB: Mat4; frameA: Mat4; frameB: Mat4; error: boolean; selected: boolean; size: number }) {
  const ma = multiply(worldA, frameA), mb = multiply(worldB, frameB)
  const ring = useMemo(() => Array.from({ length: 33 }, (_, i) => [Math.cos((i / 32) * Math.PI * 2) * size * 0.55, Math.sin((i / 32) * Math.PI * 2) * size * 0.55, 0] as Vec3), [size])
  const color = error ? '#e05a50' : selected ? '#ffd24d' : '#5fb3c4'
  const w = selected ? 2.5 : 1.6
  const apart = Math.hypot(...(add(point(mb, [0, 0, 0]), [-ma[12], -ma[13], -ma[14]]) as Vec3)) > size * 0.05
  return (
    <group name={'joint-' + id}>
      <Line points={ring.map((p) => point(ma, p))} color={color} lineWidth={w} raycast={() => null} />
      <Line points={[point(ma, [0, 0, 0]), point(ma, [0, 0, size * 1.3])]} color={color} lineWidth={w} raycast={() => null} />
      <Line points={[point(ma, [0, 0, size * 1.3]), point(ma, [size * 0.12, 0, size * 1.05])]} color={color} lineWidth={w} raycast={() => null} />
      <Line points={[point(ma, [0, 0, size * 1.3]), point(ma, [-size * 0.12, 0, size * 1.05])]} color={color} lineWidth={w} raycast={() => null} />
      <mesh position={[ma[12], ma[13], ma[14]]} raycast={() => null}>
        <sphereGeometry args={[size * 0.09, 12, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {apart && <Line points={[point(ma, [0, 0, 0]), point(mb, [0, 0, 0])]} color={color} lineWidth={1} dashed dashSize={size * 0.2} gapSize={size * 0.12} transparent opacity={0.7} raycast={() => null} />}
    </group>
  )
}

function JointGlyphs() {
  const joints = useDoc((s) => s.assembly.joints)
  const preview = useAssemblyRuntime((s) => s.previewJoint)
  const selected = useAssemblyRuntime((s) => s.selectedJoint)
  const panel = useAssemblyRuntime((s) => s.panel)
  const place = usePlacement()
  const hidden = useUi((s) => s.hiddenIds)
  const size = useGlyphSize()
  const show = panel === 'joints' || !!preview || !!selected
  if (!show) return null
  const list = [...joints.filter((j) => j.id !== preview?.id), ...(preview ? [preview] : [])]
  return (
    <group name="joint-glyphs">
      {list.filter((j) => !j.suppressed && place.worlds[j.a.occ] && place.worlds[j.b.occ] && !j.a.occ.split('/').some((p) => hidden[p])).map((j) => (
        <JointGlyph
          key={j.id} id={j.id} size={size}
          worldA={place.worlds[j.a.occ]} worldB={place.worlds[j.b.occ]}
          frameA={multiply(originMatrix(j.a.frame), staticMatrix(j))} frameB={originMatrix(j.b.frame)}
          error={!!place.solve.errors[j.id]} selected={selected === j.id || preview?.id === j.id}
        />
      ))}
    </group>
  )
}

/** Candidate snap points under the pointer while a joint origin is being picked. */
function SnapGlyphs() {
  const snapping = useUi((s) => s.pickKinds.includes('snap'))
  const hover = useAssemblyRuntime((s) => s.snapHover)
  const instances = useInstances()
  const size = useGlyphSize()
  const inst = hover ? instances.find((i) => i.key === hover.inst) : undefined
  const pts = inst ? snapPoints(inst.body) : []
  if (!snapping || !hover || !inst) return null
  const nearest = pts[hover.index]
  if (!nearest) return null
  const w = inst.world
  const frame = multiply(w, frameMatrix({ origin: nearest.pos, z: nearest.z, x: nearest.x }))
  const near = hover.near.filter((i) => i !== hover.index && pts[i])
  return (
    <group name="snap-glyphs">
      {near.map((i) => {
        const p = point(w, pts[i].pos)
        return (
          <mesh key={i} position={p} raycast={() => null} renderOrder={30}>
            <sphereGeometry args={[size * 0.13, 12, 8]} />
            <meshBasicMaterial color={KIND_COLOR[pts[i].kind]} depthTest={false} transparent opacity={0.8} />
          </mesh>
        )
      })}
      <group name="snap-nearest" userData={{ snapKind: nearest.kind }}>
        <Line points={Array.from({ length: 33 }, (_, i) => point(frame, [Math.cos((i / 32) * Math.PI * 2) * size * 0.4, Math.sin((i / 32) * Math.PI * 2) * size * 0.4, 0]))} color={KIND_COLOR[nearest.kind]} lineWidth={2.5} depthTest={false} raycast={() => null} renderOrder={31} />
        <Line points={[point(frame, [0, 0, 0]), point(frame, [0, 0, size * 1.1])]} color={KIND_COLOR[nearest.kind]} lineWidth={2.5} depthTest={false} raycast={() => null} renderOrder={31} />
        <mesh position={[frame[12], frame[13], frame[14]]} raycast={() => null} renderOrder={31}>
          <sphereGeometry args={[size * 0.17, 14, 10]} />
          <meshBasicMaterial color={KIND_COLOR[nearest.kind]} depthTest={false} />
        </mesh>
        <Html position={[frame[12], frame[13], frame[14]]} style={{ pointerEvents: 'none' }} zIndexRange={[10, 0]}>
          <div className="snap-label" data-testid="snap-label">{SNAP_LABEL[nearest.kind]}</div>
        </Html>
      </group>
    </group>
  )
}

/** Trails of the explode steps: from where each component sits assembled to where it is now. */
function ExplodeTrails() {
  const assembly = useDoc((s) => s.assembly)
  const geometry = useDoc((s) => s.geometry)
  const amount = useAssemblyRuntime((s) => s.explode)
  const selectedStep = useAssemblyRuntime((s) => s.explodeStep)
  const panel = useAssemblyRuntime((s) => s.panel)
  const drive = useAssemblyRuntime((s) => s.drive)
  const size = useGlyphSize()
  const place = useMemo(() => placeAssembly(assembly, drive, null, 0), [assembly, drive])
  const centers = useMemo(() => {
    // bounding box centre of everything inside each instance, assembled
    const acc: Record<string, { lo: Vec3; hi: Vec3 }> = {}
    const byDef = new Map<string, typeof geometry>()
    for (const b of geometry) (byDef.get(assembly.bodyOwner[b.id] ?? b.component ?? 'root') ?? byDef.set(assembly.bodyOwner[b.id] ?? b.component ?? 'root', []).get(assembly.bodyOwner[b.id] ?? b.component ?? 'root')!).push(b)
    for (const n of place.nodes) {
      for (const b of byDef.get(n.component) ?? []) {
        const m = b.placement ? multiply(place.worlds[n.id], b.placement) : place.worlds[n.id]
        const p = b.mesh.positions
        for (let k = 0; k < p.length; k += 3) {
          const w = point(m, [p[k], p[k + 1], p[k + 2]])
          // every ancestor path accumulates it too, so a step on a parent moves its whole content
          let path: string | null = n.id
          while (path) {
            const e = (acc[path] ??= { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] })
            for (let a = 0; a < 3; a++) { e.lo[a] = Math.min(e.lo[a], w[a]); e.hi[a] = Math.max(e.hi[a], w[a]) }
            path = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
          }
        }
      }
    }
    return Object.fromEntries(Object.entries(acc).map(([k, e]) => [k, [(e.lo[0] + e.hi[0]) / 2, (e.lo[1] + e.hi[1]) / 2, (e.lo[2] + e.hi[2]) / 2] as Vec3]))
  }, [place, geometry, assembly.bodyOwner])
  const steps = assembly.explode.steps
  if (!steps.length || (amount <= 0 && panel !== 'explode')) return null
  const total = explodeOffsets(place.nodes, steps, amount)
  return (
    <group name="explode-trails">
      {steps.flatMap((s) => (s.trail || s.id === selectedStep ? s.occs : []).map((o) => ({ s, o }))).filter(({ o }) => centers[o]).map(({ s, o }) => {
        const a = centers[o]
        const b = add(a, total[o] ?? [0, 0, 0]) as Vec3
        const on = s.id === selectedStep
        return (
          <group key={s.id + o}>
            <Line points={[a, b]} color={on ? '#ffd24d' : '#9aa3ad'} lineWidth={on ? 2.2 : 1.4} dashed dashSize={size * 0.25} gapSize={size * 0.16} raycast={() => null} depthTest={false} renderOrder={25} />
            <mesh position={a} raycast={() => null} renderOrder={25}>
              <sphereGeometry args={[size * 0.08, 10, 8]} />
              <meshBasicMaterial color={on ? '#ffd24d' : '#9aa3ad'} depthTest={false} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

function OverlapMesh({ positions, indices }: { positions: Float32Array; indices: Uint32Array }) {
  const geo = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(positions, 3))
    g.setIndex(new BufferAttribute(indices, 1))
    g.computeVertexNormals()
    return g
  }, [positions, indices])
  useEffect(() => () => geo.dispose(), [geo])
  return (
    <mesh geometry={geo} raycast={() => null} renderOrder={22} userData={{ noAo: true }}>
      <meshBasicMaterial color="#ff2d20" transparent opacity={0.9} side={DoubleSide} depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
    </mesh>
  )
}

/** The overlaps the interference check found, in red, and the closest approach of a clearance report. */
function CheckOverlays() {
  const report = useAssemblyRuntime((s) => s.interference)
  const clearance = useAssemblyRuntime((s) => s.clearance)
  const size = useGlyphSize()
  return (
    <group name="check-overlays">
      {report && !report.stale && report.hits.map((h, i) => <OverlapMesh key={i} positions={h.positions} indices={h.indices} />)}
      {clearance && (
        <group name="clearance">
          <Line points={[clearance.pa, clearance.pb]} color="#ffd24d" lineWidth={2.5} depthTest={false} raycast={() => null} renderOrder={26} />
          {[clearance.pa, clearance.pb].map((p, i) => (
            <mesh key={i} position={p} raycast={() => null} renderOrder={26}>
              <sphereGeometry args={[size * 0.1, 12, 8]} />
              <meshBasicMaterial color="#ffd24d" depthTest={false} />
            </mesh>
          ))}
          <Html position={[(clearance.pa[0] + clearance.pb[0]) / 2, (clearance.pa[1] + clearance.pb[1]) / 2, (clearance.pa[2] + clearance.pb[2]) / 2]} style={{ pointerEvents: 'none' }} zIndexRange={[10, 0]}>
            <div className="snap-label" data-testid="clearance-label">{clearance.distance === 0 ? 'touching' : `${+clearance.distance.toFixed(3)} mm`}</div>
          </Html>
        </group>
      )}
    </group>
  )
}

export function AssemblyLayer() {
  const any = useDoc((s) => s.assembly.occurrences.length > 0)
  if (!any) return null
  return (
    <>
      <ComponentOrigins />
      <JointGlyphs />
      <SnapGlyphs />
      <ExplodeTrails />
      <CheckOverlays />
    </>
  )
}

