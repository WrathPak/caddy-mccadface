import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { EffectComposer, SSAO } from '@react-three/postprocessing'
import { BlendFunction } from 'postprocessing'
import type { Object3D } from 'three'
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

/**
 * SSAO reads the depth / normal pre-pass. Translucent overlays that do not write depth (the infinite grid, origin
 * planes, selection tints, x-ray bodies) must not be part of it, otherwise the AO is computed against them and every
 * face that crosses one picks up speckled shadows. The pre-pass renders the whole scene, so hide those objects for it.
 */
function useAoOverlayMask(composer: { current: unknown }, enabled: boolean) {
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const passes = (composer.current as any)?.passes as { name?: string; render: (...a: unknown[]) => void }[] | undefined
    const pass = passes?.find((p) => p.name === 'NormalPass')
    if (!enabled || !pass) return
    const orig = pass.render
    pass.render = function (this: unknown, ...a: unknown[]) {
      const hidden: Object3D[] = []
      scene.traverse((o) => {
        const m = (o as { material?: { transparent?: boolean; depthWrite?: boolean } | { transparent?: boolean; depthWrite?: boolean }[] }).material
        const mat = Array.isArray(m) ? m[0] : m
        if (o.visible && ((mat && mat.transparent && mat.depthWrite === false) || o.userData.noAo)) { o.visible = false; hidden.push(o) }
      })
      try { orig.apply(this, a) } finally { for (const o of hidden) o.visible = true }
    }
    return () => { pass.render = orig }
  })
}

export function Scene() {
  const composer = useRef<unknown>(null)
  const projection = useUi((s) => s.projection)
  const ssao = useUi((s) => s.ssao)
  const showOrigin = useUi((s) => s.showOrigin)
  const showGrid = useUi((s) => s.showGrid)
  const sketching = useUi((s) => s.sketchMode)
  const sectioned = useUi((s) => s.section.on)
  const colors = useVpColors()
  useAoOverlayMask(composer, ssao)

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
      <CaptureRegistrar />
      {import.meta.env.DEV && <DebugProbe />}
      {ssao && !sectioned && <HairOverlayPass />}
      {ssao && !sectioned && (
        <EffectComposer ref={composer as never} enableNormalPass multisampling={0}>
          <SSAO blendFunction={BlendFunction.MULTIPLY} samples={16} rings={4} radius={0.06} intensity={8} luminanceInfluence={0.5} bias={0.1} />
        </EffectComposer>
      )}
    </>
  )
}
