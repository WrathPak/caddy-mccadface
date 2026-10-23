/** Dev-only `window.__caddy` handle: stores and actions for the Playwright e2e specs (never shipped in production builds). */
import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import type { Camera, Raycaster, Scene, WebGLRenderer } from 'three'
import { runCommand } from './commands'
import { regenerate } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import { useSketch } from '@/sketch/store'
import { useUi } from '@/store/ui'
import { useHairView } from '@/features/hair/store'
import { useHairPaint } from '@/features/hair/paint'
import { importFiles, saveDocument } from '@/io/actions'
import { parseProject, serializeProject } from '@/io/project'
import { usePreview } from '@/viewport/preview'
import { usePlanes } from '@/sketch/planes'
import { viewportBus } from '@/viewport/bus'

export function installDebugHandle() {
  ;(window as unknown as { __caddy: unknown }).__caddy = {
    doc: useDoc, ui: useUi, sketch: useSketch, hair: useHairView, preview: usePreview, planes: usePlanes, paint: useHairPaint, bus: viewportBus,
    runCommand, regenerate, importFiles, saveDocument, serializeProject, parseProject,
  }
}

interface Handle { three?: { camera: Camera; scene: Scene; raycaster: Raycaster; gl: WebGLRenderer; width: number; height: number } }

/** Rendered inside the R3F canvas (dev only): exposes the live camera so specs can project 3D points to screen pixels. */
export function DebugProbe() {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const scene = useThree((s) => s.scene)
  const raycaster = useThree((s) => s.raycaster)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    ;(window as unknown as { __caddy: Handle }).__caddy.three = { camera, scene, raycaster, gl, width: size.width, height: size.height }
  })
  return null
}
