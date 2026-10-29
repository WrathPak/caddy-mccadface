import { useEffect, useRef } from 'react'
import { TransformControls } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { Euler, type Group } from 'three'
import { useMove } from '@/features/move'
import { setCapture } from './capture'
import { markGrab } from './touchGrab'
import { useDevice } from '@/app/device'

const R2D = 180 / Math.PI

/** On-canvas gizmo for the Move feature; drags push values back into the open Inspector. */
export function MoveGizmo() {
  const m = useMove()
  const ref = useRef<Group>(null)
  const coarse = useDevice((d) => d.coarse)
  if (!m.active || !m.bodyIds.length) return null
  const pos: [number, number, number] = [m.pivot[0] + m.translate[0], m.pivot[1] + m.translate[1], m.pivot[2] + m.translate[2]]
  const rot = new Euler(m.rotate[0] / R2D, m.rotate[1] / R2D, m.rotate[2] / R2D, 'ZYX')
  const onChange = () => {
    const o = ref.current
    const push = useMove.getState().push
    if (!o || !push) return
    const st = useMove.getState()
    if (st.mode === 'translate') {
      push({ translate: [o.position.x - st.pivot[0], o.position.y - st.pivot[1], o.position.z - st.pivot[2]].map((v) => +v.toFixed(4)) as [number, number, number] })
    } else if (st.mode === 'rotate') {
      push({ rotate: [o.rotation.x * R2D, o.rotation.y * R2D, o.rotation.z * R2D].map((v) => +v.toFixed(3)) as [number, number, number] })
    } else {
      const s = (o.scale.x + o.scale.y + o.scale.z) / 3
      push({ scale: +Math.max(0.001, s).toFixed(4) })
    }
  }
  return (
    <TransformControls mode={m.mode} space="world" size={coarse ? 1.4 : 0.9} onObjectChange={onChange} onMouseDown={markGrab}>
      <group ref={ref} position={pos} rotation={m.mode === 'rotate' ? rot : undefined} scale={m.mode === 'scale' ? m.scale : 1} />
    </TransformControls>
  )
}

/** Registers a viewport thumbnail grabber for project saves. */
export function CaptureRegistrar() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    setCapture(
      () =>
        new Promise((resolve) => {
          gl.render(scene, camera)
          const src = gl.domElement
          const c = document.createElement('canvas')
          const k = 256 / Math.max(src.width, src.height, 1)
          c.width = Math.max(1, Math.round(src.width * k))
          c.height = Math.max(1, Math.round(src.height * k))
          c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
          c.toBlob(async (b) => resolve(b ? new Uint8Array(await b.arrayBuffer()) : null), 'image/png')
        }),
    )
    return () => setCapture(null)
  }, [gl, scene, camera])
  return null
}
