import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { EffectComposer, N8AO } from '@react-three/postprocessing'
import { useUi } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { DebugProbe } from '@/app/debug'
import { Bodies } from './Bodies'
import { ContactShadow, SelectionOutline, StudioEnv } from './Studio'
import { CaptureRegistrar, MoveGizmo } from './MoveGizmo'
import { InfiniteGrid } from './InfiniteGrid'
import { ConstructionPlanes, Origin } from './Origin'
import { MeasureOverlay } from './MeasureOverlay'
import { NavControls, FOV } from './NavControls'
import { ViewCubeSync } from './ViewCube'
import { useVpColors } from './colors'
import { MotionTracker } from './motion'
import { AngleManipulator } from './AngleManipulator'
import { ArrowManipulator, CurvePicker, PreviewLayer, ProfilePicker } from './preview'
import { ConstructLayer } from '@/features/modeling-tools/ConstructLayer'
import { SketchOverlay } from '@/sketch/SketchOverlay'
import { SketchDisplay } from '@/sketch/SketchDisplay'
import { PlanePicker } from '@/sketch/PlanePicker'
import { HairPaintTool, HairRegionOverlay } from '@/features/hair/PaintTool'
import { HairDirectionOverlay, HairOverlayPass, HairPreviewLayer } from '@/features/hair/layer'
import { DetailOverlay } from '@/features/detail/overlay'
import { PrintCanvas } from '@/features/print/PrintCanvas'
import { DEBUG_HANDLE } from '@/app/flags'
import { RenderScene } from '@/render/RenderScene'
import { AssemblyLayer } from '@/assembly/AssemblyLayer'

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

/** Automated browsers (the e2e runs on software GL) get a cheaper AO sample count; the denoise is the same. */
const AO_LOW = typeof navigator !== 'undefined' && navigator.webdriver

/** Everything AO: lives in its own component so camera-rest changes do not re-render the whole scene. */
function AoLayer() {
  const ssao = useUi((s) => s.ssao)
  const sectioned = useUi((s) => s.section.on)
  const setAoActive = useUi((s) => s.setAoActive)
  const hasBodies = useDoc((s) => s.geometry.length > 0)
  // AO draws the scene three times, and its shaders take a long single frame to link; for a mesh of more than 150 thousand
  // triangles that is what makes the view stutter, so those scenes are drawn plainly
  const heavy = useDoc((s) => s.geometry.some((b) => !!b.mesh.lod || b.mesh.indices.length > 450_000))
  const wanted = ssao && !sectioned && hasBodies && !heavy
  // AO stays on while the camera moves: switching it off for motion and back on at rest made every zoom step flash dark and light
  const active = wanted
  useEffect(() => { setAoActive(active); return () => setAoActive(false) }, [active, setAoActive])
  useAoOverlayMask(active)
  if (!wanted) return null
  return (
    <>
      {active && <HairOverlayPass />}
      <EffectComposer multisampling={4}>
        <N8AO halfRes depthAwareUpsampling quality={AO_LOW ? 'performance' : 'medium'} aoRadius={14} screenSpaceRadius={false} distanceFalloff={1} intensity={1.6} aoSamples={16} denoiseSamples={8} denoiseRadius={12} />
      </EffectComposer>
    </>
  )
}

export function Scene() {
  const projection = useUi((s) => s.projection)
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
      <MotionTracker />
      <ViewCubeSync />
      <StudioEnv />
      <hemisphereLight args={['#ffffff', '#4a4f57', 0.55]} />
      <directionalLight position={[80, -120, 160]} intensity={1.5} />
      <directionalLight position={[-120, 80, 40]} intensity={0.45} />
      <directionalLight position={[20, 140, 60]} intensity={0.35} />
      <ContactShadow />
      {showGrid && !sketching && <InfiniteGrid />}
      {showOrigin && !sketching && <Origin />}
      {showOrigin && !sketching && <ConstructionPlanes />}
      <Bodies />
      <SelectionOutline />
      <AssemblyLayer />
      <MoveGizmo />
      <SketchDisplay />
      <SketchOverlay />
      <PlanePicker />
      <PreviewLayer />
      <ProfilePicker />
      <CurvePicker />
      <ArrowManipulator />
      <AngleManipulator />
      <ConstructLayer />
      <MeasureOverlay />
      <HairRegionOverlay />
      <HairPreviewLayer />
      <HairDirectionOverlay />
      <HairPaintTool />
      <DetailOverlay />
      <PrintCanvas />
      <RenderScene />
      <CaptureRegistrar />
      {DEBUG_HANDLE && <DebugProbe />}
      <AoLayer />
    </>
  )
}
