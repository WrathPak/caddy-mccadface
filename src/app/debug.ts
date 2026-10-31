/** Dev-only `window.__caddy` handle: stores and actions for the Playwright e2e specs (never shipped in production builds). */
import { useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import type { Camera, Raycaster, Scene, WebGLRenderer } from 'three'
import { allCommands, runCommand } from './commands'
import { regenerate } from '@/doc/engine'
import { useDoc } from '@/doc/store'
import { useSketch } from '@/sketch/store'
import { useSketchData } from '@/sketch/draw'
import { useUi } from '@/store/ui'
import { useHairView } from '@/features/hair/store'
import { useHairPaint } from '@/features/hair/paint'
import { flushAutosave, importFiles, openProjectFile, saveDocument, useRecovery } from '@/io/actions'
import { parseProject, serializeProject } from '@/io/project'
import { usePreview, useManip, MANIP_SLOTS } from '@/viewport/preview'
import { useAngleManip, ANGLE_SLOTS } from '@/viewport/AngleManipulator'
import { usePlanes } from '@/sketch/planes'
import { viewportBus } from '@/viewport/bus'
import { navClock } from '@/viewport/navClock'
import { lodState, useMotion } from '@/viewport/motion'
import { useProjects } from '@/projects/store'
import { usePlugins, hostOf } from '@/api/pluginStore'
import { drawingDebug } from '@/drawing/debug'
import { assemblyDebug } from '@/assembly/debug'
import * as updates from './updates'
import { useToast } from '@/ui/Modal'
import { useSettings } from '@/settings/settings'
import { useDiskAutosave } from '@/io/diskAutosave'

const frameHook: { redraw: (() => void) | null } = { redraw: null }

/** Camera clock controls for specs: freeze it, then step animation / inertia time by hand, one rendered frame per step. */
const navTools = {
  freeze: () => navClock.freeze(),
  unfreeze: () => navClock.unfreeze(),
  /** Move the nav clock on without rendering (e.g. between simulated pointer moves). */
  tick: (ms: number) => navClock.advance(ms),
  /** Move the nav clock on in 16 ms frames, rendering each one. */
  step: async (ms: number, frame = 16) => {
    for (let t = 0; t < ms; t += frame) {
      navClock.advance(Math.min(frame, ms - t))
      frameHook.redraw?.()
      // the redraw is queued before this callback, so the frame for this step has run by the time it fires
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
    }
  },
  /** Let running camera animations and inertia finish on stepped time, however slow the renderer is. */
  settle: async (ms = 500) => {
    const wasFrozen = navClock.isFrozen()
    navClock.freeze()
    await navTools.step(ms, 250)
    if (!wasFrozen) navClock.unfreeze()
  },
}

export function installDebugHandle() {
  ;(window as unknown as { __caddy: unknown }).__caddy = {
    doc: useDoc, ui: useUi, sketch: useSketch, sketchData: useSketchData, hair: useHairView, preview: usePreview, manip: useManip, manips: MANIP_SLOTS, angleManip: useAngleManip, angleManips: ANGLE_SLOTS, planes: usePlanes, paint: useHairPaint, bus: viewportBus, motion: useMotion, lodState, projects: useProjects, plugins: usePlugins, pluginHost: hostOf,
    ...((window as unknown as { __caddyExtra?: object }).__caddyExtra ?? {}),
    toast: useToast, settings: useSettings, updates, diskAutosave: useDiskAutosave, flushAutosave, openProjectFile, recovery: useRecovery,
    assembly: assemblyDebug, nav: navTools, drawing: drawingDebug, runCommand, allCommands, regenerate, importFiles, saveDocument, serializeProject, parseProject,
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
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    frameHook.redraw = invalidate
    ;(window as unknown as { __caddy: Handle }).__caddy.three = { camera, scene, raycaster, gl, width: size.width, height: size.height }
  })
  return null
}
