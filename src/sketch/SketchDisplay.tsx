/** Finished sketches in the viewport (curves only; profile picking lives with the features that consume them). */
import { useMemo } from 'react'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { useVpColors } from '@/viewport/colors'
import { entityPolylines, useSketchData } from './draw'
import { planeQuaternion } from './plane'
import { Segments, toPairs } from './SketchOverlay'
import { useSketch } from './store'
import type { SketchData } from './types'

const DANGER = '#d9625a'

function One({ data, color, danger }: { data: SketchData; color: string; danger: string }) {
  const q = useMemo(() => planeQuaternion(data.plane), [data.plane])
  const { solid, cons, broken } = useMemo(() => {
    const solid: [number, number][] = [], cons: [number, number][] = [], broken: [number, number][] = []
    for (const p of entityPolylines({ entities: data.entities, constraints: data.constraints, next: 0 })) (p.broken ? broken : p.construction ? cons : solid).push(...toPairs(p.pts))
    return { solid, cons, broken }
  }, [data])
  return (
    <group position={data.plane.origin} quaternion={q}>
      <Segments pairs={solid} color={color} width={1.4} wpp={0.2} order={6} />
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
  return (
    <>
      {features.map((f, i) => {
        const d = data[f.id]
        if (f.type !== 'sketch' || !d || i >= rollback || f.suppressed || hidden[f.id] || f.id === editing) return null
        return <One key={f.id} data={d} color={colors.accent} danger={DANGER} />
      })}
    </>
  )
}
