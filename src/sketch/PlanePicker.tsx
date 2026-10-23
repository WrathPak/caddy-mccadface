/** Clickable origin planes shown while "Create Sketch" waits for a plane or face. */
import { useState } from 'react'
import { DoubleSide } from 'three'
import { useUi } from '@/store/ui'
import { useVpColors } from '@/viewport/colors'
import { useSketchPick } from './create'
import { originPlane, planeQuaternion, originPlaneId, type OriginPlaneName } from './plane'

const NAMES: OriginPlaneName[] = ['XY', 'XZ', 'YZ']
const S = 22

export function PlanePicker() {
  const picking = useSketchPick((s) => s.picking)
  const colors = useVpColors()
  const [hover, setHover] = useState<string | null>(null)
  if (!picking) return null
  return (
    <group>
      {NAMES.map((n) => {
        const p = originPlane(n)
        const hot = hover === n
        return (
          <mesh
            key={n}
            quaternion={planeQuaternion(p)}
            renderOrder={5}
            onPointerMove={(e) => { e.stopPropagation(); if (hover !== n) setHover(n) }}
            onPointerOut={() => setHover(null)}
            onClick={(e) => { e.stopPropagation(); useUi.getState().setSelection([{ kind: 'plane', id: originPlaneId(n) }]) }}
          >
            <planeGeometry args={[S * 2, S * 2]} />
            <meshBasicMaterial color={colors.accent} transparent opacity={hot ? 0.38 : 0.14} side={DoubleSide} depthWrite={false} />
          </mesh>
        )
      })}
    </group>
  )
}
