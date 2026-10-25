import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { DepthOfField, EffectComposer } from '@react-three/postprocessing'
import { Color, DirectionalLight, HemisphereLight, MathUtils, PCFShadowMap, PMREMGenerator, type Group, type Mesh, type PerspectiveCamera } from 'three'
import { useDoc } from '@/doc/store'
import { useMove } from '@/features/move'
import { useUi } from '@/store/ui'
import { FOV } from '@/viewport/NavControls'
import { useVpColors } from '@/viewport/colors'
import { sectionPlane } from '@/viewport/section'
import { computeAppearanceMap } from './appearanceMap'
import { liveView } from './liveView'
import { ENV_ROTATION, buildGround, buildKeyLight, buildModel, disposeModel, envTexture, modelBounds } from './sceneBuild'
import { fovForFocal } from './settingsCore'
import { useRenderSettings } from './settings'

const PLA = { material: 'pla', color: '' }

/** The material of every assigned body / face, drawn over the plain body mesh (which still takes all the picking). */
function AppearanceOverlay() {
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const geometry = useDoc((s) => s.geometry)
  const hidden = useUi((s) => s.hiddenIds)
  const section = useUi((s) => s.section)
  const move = useMove()
  const invalidate = useThree((s) => s.invalidate)
  const map = useMemo(() => computeAppearanceMap(features, rollback, geometry), [features, rollback, geometry])
  const model = useMemo<Group | null>(() => {
    if (!map.size) return null
    const skip = { ...hidden }
    if (move.active) for (const id of move.bodyIds) skip[id] = true
    const g = buildModel(geometry, { appearance: map, hidden: skip, live: true, onlyAssigned: true, fallback: PLA })
    const clip = section.on ? [sectionPlane(section)] : []
    g.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      m.raycast = () => {}
      m.renderOrder = 1
      const mat = m.material as Mesh['material'] & { polygonOffset: boolean; polygonOffsetFactor: number; polygonOffsetUnits: number; clippingPlanes: unknown }
      mat.polygonOffset = true
      mat.polygonOffsetFactor = -1
      mat.polygonOffsetUnits = -1
      mat.clippingPlanes = clip
    })
    return g
  }, [map, geometry, hidden, section, move.active, move.bodyIds])
  useEffect(() => {
    invalidate()
    return () => { if (model) disposeModel(model) }
  }, [model, invalidate])
  return model ? <primitive object={model} /> : null
}

/** Thin lens depth of field: the in-focus range in scene units (mm), from a 0.03 mm circle of confusion. */
export function focusRange(focalMm: number, fStop: number, focus: number): number {
  const c = 0.03
  const H = (focalMm * focalMm) / (fStop * c) + focalMm
  const near = (focus * (H - focalMm)) / (H + focus - 2 * focalMm)
  const far = focus < H ? (focus * (H - focalMm)) / (H - focus) : Infinity
  return Math.max(1, Math.min(far, focus * 4) - near)
}

/** The lit stage of the Render workspace: environment, ground, shadow, camera lens and depth of field. */
function RenderStage() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const invalidate = useThree((s) => s.invalidate)
  const s = useRenderSettings((x) => x.s)
  const geometry = useDoc((x) => x.geometry)
  const features = useDoc((x) => x.features)
  const rollback = useDoc((x) => x.rollback)
  const hidden = useUi((x) => x.hiddenIds)
  const colors = useVpColors()

  // the AO composer and this stage's depth of field composer cannot both own the frame; the grid and the origin would show through the ground
  useEffect(() => {
    const was = useUi.getState()
    useUi.setState({ ssao: false, showGrid: false, showOrigin: false })
    return () => useUi.setState({ ssao: was.ssao, showGrid: was.showGrid, showOrigin: was.showOrigin })
  }, [])

  // the viewport's own lights give way to the environment
  useEffect(() => {
    const off: { visible: boolean }[] = []
    scene.children.forEach((o) => {
      if (o instanceof HemisphereLight || (o instanceof DirectionalLight && !o.userData.renderStage)) { off.push(o); o.visible = false }
    })
    invalidate()
    return () => { off.forEach((o) => { o.visible = true }); invalidate() }
  }, [scene, invalidate])

  useEffect(() => {
    gl.toneMappingExposure = s.exposure
    invalidate()
    return () => { gl.toneMappingExposure = 1 }
  }, [gl, s.exposure, invalidate])

  // environment light and the backdrop
  useEffect(() => {
    const pm = new PMREMGenerator(gl)
    const rt = pm.fromEquirectangular(envTexture(s.env))
    const prevEnv = scene.environment, prevBg = scene.background
    scene.environment = rt.texture
    scene.environmentRotation.copy(ENV_ROTATION)
    scene.backgroundRotation.copy(ENV_ROTATION)
    scene.background = s.backdrop === 'environment' ? rt.texture : new Color(s.backdropColor)
    invalidate()
    return () => {
      scene.environment = prevEnv
      scene.background = prevBg
      scene.environmentRotation.set(0, 0, 0)
      scene.backgroundRotation.set(0, 0, 0)
      rt.dispose()
      pm.dispose()
      invalidate()
    }
  }, [gl, scene, s.env, s.backdrop, s.backdropColor, invalidate])

  // ground, mirror and the shadow light follow the model
  useEffect(() => {
    const bodies = scene.getObjectByName('bodies')
    const map = computeAppearanceMap(features, rollback, geometry)
    const bounds = modelBounds(geometry, hidden)
    if (bounds.isEmpty()) return
    gl.shadowMap.enabled = s.shadow
    gl.shadowMap.type = PCFShadowMap
    gl.shadowMap.needsUpdate = true
    const casters: Mesh[] = []
    bodies?.traverse((o) => { const m = o as Mesh; if (m.isMesh && !m.castShadow) { m.castShadow = true; casters.push(m) } })
    const ground = buildGround(bounds, s, { mode: 'raster' }, () => buildModel(geometry, { appearance: map, hidden, live: true, fallback: PLA }))
    if (ground) scene.add(ground)
    let key: DirectionalLight | null = null
    if (s.shadow) {
      key = buildKeyLight(bounds, s.env)
      key.userData.renderStage = true
      scene.add(key, key.target)
    }
    invalidate()
    return () => {
      casters.forEach((m) => { m.castShadow = false })
      if (ground) {
        scene.remove(ground)
        ground.traverse((o) => { const m = o as Mesh; m.geometry?.dispose?.(); (m.material as { dispose?: () => void } | undefined)?.dispose?.() })
      }
      if (key) { scene.remove(key, key.target); key.dispose() }
      gl.shadowMap.enabled = false
      invalidate()
    }
  }, [gl, scene, geometry, features, rollback, hidden, s, colors, invalidate])

  // the lens
  useFrame(() => {
    const c = camera as PerspectiveCamera
    if (c.isPerspectiveCamera) {
      const fov = fovForFocal(s.focalMm)
      if (Math.abs(c.fov - fov) > 1e-6) { c.fov = fov; c.updateProjectionMatrix() }
    }
  })
  useEffect(() => {
    invalidate()
    return () => {
      const c = camera as PerspectiveCamera
      if (c.isPerspectiveCamera) { c.fov = FOV; c.updateProjectionMatrix() }
      invalidate()
    }
  }, [camera, s.focalMm, invalidate])

  if (!s.dof || !(camera as PerspectiveCamera).isPerspectiveCamera) return null
  return (
    <EffectComposer multisampling={4}>
      <DepthOfField worldFocusDistance={s.focusDistance} worldFocusRange={focusRange(s.focalMm, s.fStop, s.focusDistance)} bokehScale={MathUtils.clamp(24 / s.fStop, 1, 14)} />
    </EffectComposer>
  )
}

export function RenderScene() {
  const workspace = useUi((s) => s.workspace)
  const camera = useThree((s) => s.camera)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    liveView.camera = camera
    liveView.invalidate = invalidate
    return () => { liveView.camera = null; liveView.invalidate = null }
  }, [camera, invalidate])
  return (
    <>
      <AppearanceOverlay />
      {workspace === 'render' && <RenderStage />}
    </>
  )
}
