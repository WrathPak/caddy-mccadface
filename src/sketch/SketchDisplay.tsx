/** Finished sketches in the viewport (curves only; profile picking lives with the features that consume them). */
import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { BufferGeometry, Float32BufferAttribute } from 'three'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { useVpColors } from '@/viewport/colors'
import { entityPolylines, useSketchData } from './draw'
import { planeQuaternion } from './plane'
import { Segments, toPairs } from './SketchOverlay'
import { useSketch } from './store'
import type { SketchData } from './types'

const DANGER = '#d9625a'

function One({ id, data, color, danger, pick }: { id: string; data: SketchData; color: string; danger: string; pick: boolean }) {
  const hover = useUi((s) => s.hover)
  const selected = useUi((s) => s.selection.some((r) => r.kind === 'sketch' && r.id === id))
  const hot = pick && hover?.kind === 'sketch' && hover.id === id
  const q = useMemo(() => planeQuaternion(data.plane), [data.plane])
  const { solid, cons, broken } = useMemo(() => {
    const solid: [number, number][] = [], cons: [number, number][] = [], broken: [number, number][] = []
    for (const p of entityPolylines({ entities: data.entities, constraints: data.constraints, next: 0 })) (p.broken ? broken : p.construction ? cons : solid).push(...toPairs(p.pts))
    return { solid, cons, broken }
  }, [data])
  // hit geometry for picking the sketch by its curves
  const hit = useMemo(() => {
    const g = new BufferGeometry()
    const p: number[] = []
    for (const pl of entityPolylines({ entities: data.entities, constraints: data.constraints, next: 0 })) {
      if (pl.construction) continue
      for (let i = 0; i + 1 < pl.pts.length; i++) p.push(pl.pts[i][0], pl.pts[i][1], 0, pl.pts[i + 1][0], pl.pts[i + 1][1], 0)
    }
    g.setAttribute('position', new Float32BufferAttribute(p, 3))
    return g
  }, [data])
  const hi = hot || selected
  return (
    <group position={data.plane.origin} quaternion={q}>
      {pick && (
        <lineSegments
          geometry={hit}
          onPointerMove={(e) => { e.stopPropagation(); if (!(hover?.kind === 'sketch' && hover.id === id)) useUi.getState().setHover({ kind: 'sketch', id }) }}
          onPointerOut={() => useUi.getState().setHover(null)}
          onClick={(e) => { e.stopPropagation(); useUi.getState().setSelection([{ kind: 'sketch', id }], e.shiftKey || e.ctrlKey) }}
        >
          <lineBasicMaterial visible={false} />
        </lineSegments>
      )}
      <Segments pairs={solid} color={hi ? (hot ? '#e8b84a' : '#ffffff') : color} width={hi ? 2.6 : 1.4} wpp={0.2} order={6} />
      <Segments pairs={cons} color={color} width={1} dashed wpp={0.2} order={6} />
      <Segments pairs={broken} color={danger} width={1.8} wpp={0.2} order={7} />
    </group>
  )
}

export function SketchDisplay() {
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const hidden = useUi((s) => s.hiddenIds)
  const data = useSketchData((s) => s.data)
  const editing = useSketch((s) => s.editing)
  const colors = useVpColors()
  const pick = useUi((s) => s.pickSketches)
  // the line picking tolerance follows the zoom: about 6 px
  useFrame((state) => {
    if (!pick) return
    const cam = state.camera as { isOrthographicCamera?: boolean; zoom: number; fov: number; position: { length(): number } }
    const wpp = cam.isOrthographicCamera ? 1 / cam.zoom : (2 * cam.position.length() * Math.tan((cam.fov * Math.PI) / 360)) / state.size.height
    state.raycaster.params.Line = { threshold: wpp * 6 }
  })
  return (
    <>
      {features.map((f, i) => {
        const d = data[f.id]
        if (f.type !== 'sketch' || !d || i >= rollback || f.suppressed || hidden[f.id] || f.id === editing) return null
        return <One key={f.id} id={f.id} data={d} color={colors.accent} danger={DANGER} pick={pick} />
      })}
    </>
  )
}
