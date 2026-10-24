import { useFrame, useThree } from '@react-three/fiber'
import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { EffectComposer, N8AO } from '@react-three/postprocessing'
import { useUi } from '@/store/ui'
import { DebugProbe } from '@/app/debug'
import { Bodies } from './Bodies'
import { CaptureRegistrar, MoveGizmo } from './MoveGizmo'
import { InfiniteGrid } from './InfiniteGrid'
import { ConstructionPlanes, Origin } from './Origin'
import { MeasureOverlay } from './MeasureOverlay'
import { NavControls, FOV } from './NavControls'
import { ViewCubeSync } from './ViewCube'
import { useVpColors } from './colors'
import { ArrowManipulator, PreviewLayer, ProfilePicker } from './preview'
import { SketchOverlay } from '@/sketch/SketchOverlay'
import { SketchDisplay } from '@/sketch/SketchDisplay'
import { PlanePicker } from '@/sketch/PlanePicker'
import { HairPaintTool, HairRegionOverlay } from '@/features/hair/PaintTool'
import { HairDirectionOverlay, HairOverlayPass, HairPreviewLayer } from '@/features/hair/layer'
import { PrintCanvas } from '@/features/print/PrintCanvas'

/**
 * N8AO renders its own depth pre-pass and already keeps translucent overlays that do not write depth (infinite grid, origin
 * planes, selection tints, x-ray bodies) out of the AO. Anything flagged `userData.noAo` is additionally marked as not
 * receiving AO, so it is drawn on top of the result untouched.
 */
function useAoOverlayMask(enabled: boolean) {
  const scene = useThree((s) => s.scene)
  useFrame(() => {
    if (!enabled) return
    scene.traverse((o) => { if (o.userData.noAo && !o.userData.cannotReceiveAO) o.userData.cannotReceiveAO = true })
  })
}

export function Scene() {
  const projection = useUi((s) => s.projection)
  const ssao = useUi((s) => s.ssao)
  const showOrigin = useUi((s) => s.showOrigin)
  const showGrid = useUi((s) => s.showGrid)
  const sketching = useUi((s) => s.sketchMode)
  const sectioned = useUi((s) => s.section.on)
  const colors = useVpColors()
  useAoOverlayMask(ssao)

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
      {showOrigin && !sketching && <ConstructionPlanes />}
      <Bodies />
      <MoveGizmo />
      <SketchDisplay />
      <SketchOverlay />
      <PlanePicker />
      <PreviewLayer />
      <ProfilePicker />
      <ArrowManipulator />
      <MeasureOverlay />
      <HairRegionOverlay />
      <HairPreviewLayer />
      <HairDirectionOverlay />
      <HairPaintTool />
      <PrintCanvas />
      <CaptureRegistrar />
      {import.meta.env.DEV && <DebugProbe />}
      {ssao && !sectioned && <HairOverlayPass />}
      {ssao && !sectioned && (
        <EffectComposer multisampling={4}>
          <N8AO halfRes depthAwareUpsampling quality="medium" aoRadius={14} screenSpaceRadius={false} distanceFalloff={1} intensity={1.6} aoSamples={16} denoiseSamples={8} denoiseRadius={12} />
        </EffectComposer>
      )}
    </>
  )
}
