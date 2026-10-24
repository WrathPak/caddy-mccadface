import { useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { EffectComposer, N8AO } from '@react-three/postprocessing'
import { useUi } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { DebugProbe } from '@/app/debug'
import { Bodies } from './Bodies'
import { CaptureRegistrar, MoveGizmo } from './MoveGizmo'
import { InfiniteGrid } from './InfiniteGrid'
import { ConstructionPlanes, Origin } from './Origin'
import { MeasureOverlay } from './MeasureOverlay'
import { NavControls, FOV } from './NavControls'
import { ViewCubeSync } from './ViewCube'
import { useVpColors } from './colors'
import { navClock } from './navClock'
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

const AO_IDLE_MS = 220
/** Automated browsers (the e2e runs on software GL) get a cheaper AO sample count; the denoise is the same. */
const AO_LOW = typeof navigator !== 'undefined' && navigator.webdriver

/**
 * AO only runs while the camera is at rest: orbiting, panning and zooming draw the plain scene, and the AO fades back in
 * once the view has been still for a moment. Time comes from the nav clock, so a spec that freezes it never sees AO mid-motion.
 */
function useAoIdle(track: boolean): boolean {
  const [idle, setIdle] = useState(true)
  const invalidate = useThree((s) => s.invalidate)
  const last = useRef<number[] | null>(null)
  const lastMove = useRef(-Infinity)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useFrame((state) => {
    if (!track) return
    const m = state.camera.matrixWorld.elements
    const prev = last.current
    let moved = !prev
    if (prev) for (let i = 0; i < 16; i++) if (Math.abs(prev[i] - m[i]) > 1e-9) { moved = true; break }
    if (!prev) last.current = m.slice()
    else if (moved) for (let i = 0; i < 16; i++) prev[i] = m[i]
    const now = navClock.now()
    if (moved && prev) {
      lastMove.current = now
      if (idle) setIdle(false)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => invalidate(), AO_IDLE_MS + 30)
    } else if (!idle && now - lastMove.current >= AO_IDLE_MS) setIdle(true)
    else if (!idle) {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => invalidate(), AO_IDLE_MS + 30)
    }
  })
  return idle
}

/** Everything AO: lives in its own component so camera-rest changes do not re-render the whole scene. */
function AoLayer() {
  const ssao = useUi((s) => s.ssao)
  const sectioned = useUi((s) => s.section.on)
  const setAoActive = useUi((s) => s.setAoActive)
  const hasBodies = useDoc((s) => s.geometry.length > 0)
  const wanted = ssao && !sectioned && hasBodies
  const idle = useAoIdle(wanted)
  const active = wanted && idle
  useEffect(() => { setAoActive(active); return () => setAoActive(false) }, [active, setAoActive])
  useAoOverlayMask(active)
  if (!active) return null
  return (
    <>
      <HairOverlayPass />
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
      <AoLayer />
    </>
  )
}
