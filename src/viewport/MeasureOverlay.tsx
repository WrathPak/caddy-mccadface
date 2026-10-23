/** Dimension line, end markers and distance label for the open Measure dialog. */
import { Html, Line } from '@react-three/drei'
import { useMeasure } from '@/features/measure'

const COLOR = '#e8b84a'

export function MeasureOverlay() {
  const { a, b, label } = useMeasure()
  if (!a) return null
  const dot = (p: [number, number, number], k: string) => (
    <mesh key={k} position={p} renderOrder={40} raycast={() => null}>
      <sphereGeometry args={[0.5, 12, 12]} />
      <meshBasicMaterial color={COLOR} depthTest={false} transparent />
    </mesh>
  )
  return (
    <group name="measure">
      {dot(a, 'a')}
      {b && dot(b, 'b')}
      {b && (
        <>
          <Line name="measure-line" points={[a, b]} color={COLOR} lineWidth={1.6} depthTest={false} transparent renderOrder={40} raycast={() => null} />
          <Html position={[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]} zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
            <div className="sk-tip measure-label" data-testid="measure-label" style={{ transform: 'translate(-50%, -140%)' }}>{label}</div>
          </Html>
        </>
      )}
    </group>
  )
}
