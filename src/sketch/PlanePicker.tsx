/** Clickable origin planes shown while "Create Sketch" waits for a plane or face. */
import { useState } from 'react'
import { DoubleSide } from 'three'
import { useUi } from '@/store/ui'
import { useVpColors } from '@/viewport/colors'
import { useSketchPick } from './create'
import { useDoc } from '@/doc/store'
import { originPlane, planeQuaternion, originPlaneId, type OriginPlaneName } from './plane'
import { PLANE_FEATURES, usePlanes } from './planes'
import { useSceneHalfSize } from '@/viewport/Origin'
import type { PlaneDef } from './types'

const NAMES: OriginPlaneName[] = ['XY', 'XZ', 'YZ']

export function PlanePicker() {
  const picking = useSketchPick((s) => s.picking)
  const colors = useVpColors()
  const [hover, setHover] = useState<string | null>(null)
  const S = useSceneHalfSize()
  const features = useDoc((st) => st.features)
  const rollback = useDoc((st) => st.rollback)
  const cdata = usePlanes((st) => st.data)
  if (!picking) return null
  // beside the part, not over it: each square sits just past the corner of the model in its own plane
  const size = S * 0.5
  const h = S * 1.08 + size / 2
  const choices: { id: string; plane: PlaneDef }[] = [
    ...NAMES.map((n) => ({ id: originPlaneId(n), plane: originPlane(n) })),
    ...features.filter((f, i) => PLANE_FEATURES.has(f.type) && i < rollback && !f.suppressed && cdata[f.id]).map((f) => ({ id: f.id, plane: cdata[f.id] })),
  ]
  return (
    <group>
      {choices.map(({ id, plane }) => {
        const hot = hover === id
        return (
          // a small square off to the side of each plane: big planes through the origin hid the faces of the part
          <group key={id} position={plane.origin} quaternion={planeQuaternion(plane)}>
            <mesh
              position={[h, h, 0]}
              renderOrder={5}
              onPointerMove={(e) => { e.stopPropagation(); if (hover !== id) setHover(id) }}
              onPointerOut={() => setHover(null)}
              onClick={(e) => { e.stopPropagation(); useUi.getState().setSelection([{ kind: 'plane', id }]) }}
            >
              <planeGeometry args={[size, size]} />
              <meshBasicMaterial color={hot ? colors.sel : colors.accent} transparent opacity={hot ? 0.45 : 0.22} side={DoubleSide} depthWrite={false} depthTest={false} />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}
