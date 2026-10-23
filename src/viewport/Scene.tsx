import { OrthographicCamera, PerspectiveCamera, Line } from '@react-three/drei'
import { EffectComposer, SSAO } from '@react-three/postprocessing'
import { BlendFunction } from 'postprocessing'
import { DoubleSide } from 'three'
import { useUi } from '@/store/ui'
import { Bodies } from './Bodies'
import { CaptureRegistrar, MoveGizmo } from './MoveGizmo'
import { InfiniteGrid } from './InfiniteGrid'
import { NavControls, FOV } from './NavControls'
import { ViewCubeSync } from './ViewCube'
import { useVpColors } from './colors'
import { ArrowManipulator, PreviewLayer, ProfilePicker } from './preview'
import { SketchOverlay } from '@/sketch/SketchOverlay'
import { SketchDisplay } from '@/sketch/SketchDisplay'
import { PlanePicker } from '@/sketch/PlanePicker'

const S = 32 // origin plane half-size

function Origin() {
  const c = useVpColors()
  const planes: { rot: [number, number, number]; color: string }[] = [
    { rot: [0, 0, 0], color: c.axisZ }, // XY
    { rot: [Math.PI / 2, 0, 0], color: c.axisY }, // XZ
    { rot: [0, Math.PI / 2, 0], color: c.axisX }, // YZ
  ]
  return (
    <group renderOrder={-2}>
      {planes.map((p, i) => (
        <mesh key={i} rotation={p.rot} raycast={() => null}>
          <planeGeometry args={[S * 2, S * 2]} />
          <meshBasicMaterial color={p.color} transparent opacity={0.06} side={DoubleSide} depthWrite={false} />
        </mesh>
      ))}
      <Line points={[[0, 0, 0], [S * 1.4, 0, 0]]} color={c.axisX} lineWidth={1.5} raycast={() => null} />
      <Line points={[[0, 0, 0], [0, S * 1.4, 0]]} color={c.axisY} lineWidth={1.5} raycast={() => null} />
      <Line points={[[0, 0, 0], [0, 0, S * 1.4]]} color={c.axisZ} lineWidth={1.5} raycast={() => null} />
    </group>
  )
}

export function Scene() {
  const projection = useUi((s) => s.projection)
  const ssao = useUi((s) => s.ssao)
  const showOrigin = useUi((s) => s.showOrigin)
  const showGrid = useUi((s) => s.showGrid)
  const sketching = useUi((s) => s.sketchMode)
  const colors = useVpColors()

  return (
    <>
      <color attach="background" args={[colors.bg]} />
      {projection === 'perspective' ? (
        <PerspectiveCamera makeDefault fov={FOV} near={0.1} far={50000} position={[120, -120, 100]} up={[0, 0, 1]} />
      ) : (
        <OrthographicCamera makeDefault near={-5000} far={5000} position={[120, -120, 100]} up={[0, 0, 1]} />
      )}
      <NavControls />
      <ViewCubeSync />
      <hemisphereLight args={['#ffffff', '#4a4f57', 0.9]} />
      <directionalLight position={[80, -120, 160]} intensity={1.6} />
      <directionalLight position={[-120, 80, 40]} intensity={0.5} />
      {showGrid && !sketching && <InfiniteGrid />}
      {showOrigin && !sketching && <Origin />}
      <Bodies />
      <MoveGizmo />
      <SketchDisplay />
      <SketchOverlay />
      <PlanePicker />
      <PreviewLayer />
      <ProfilePicker />
      <ArrowManipulator />
      <CaptureRegistrar />
      {ssao && (
        <EffectComposer enableNormalPass multisampling={0}>
          <SSAO blendFunction={BlendFunction.MULTIPLY} samples={16} rings={4} radius={0.06} intensity={18} luminanceInfluence={0.5} bias={0.02} />
        </EffectComposer>
      )}
    </>
  )
}
