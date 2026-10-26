/** Runs renders for the HUD: one job at a time, with progress, cancel and the last result. */
import { create } from 'zustand'
import { downloadFile } from '@/io/files'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import { computeAppearanceMap } from './appearanceMap'
import { liveView } from './liveView'
import { RenderCancelled, canvasToPng, renderStill, renderTurntable, type EngineUsed, type RenderRequest } from './renderer'
import { useRenderSettings } from './settings'

export interface StillResult { url: string; width: number; height: number; engine: EngineUsed; note: string | null; png: Uint8Array; seconds: number }

interface JobState {
  status: 'idle' | 'running'
  kind: 'still' | 'turntable' | null
  progress: number
  text: string
  error: string | null
  still: StillResult | null
  video: { bytes: Uint8Array; seconds: number } | null
}

export const useRenderJob = create<JobState>(() => ({ status: 'idle', kind: null, progress: 0, text: '', error: null, still: null, video: null }))

let abort: AbortController | null = null

export function buildRequest(width?: number, height?: number): RenderRequest {
  const d = useDoc.getState()
  const settings = useRenderSettings.getState().s
  const cam = liveView.camera
  const pos: [number, number, number] = cam ? [cam.position.x, cam.position.y, cam.position.z] : [120, -120, 100]
  const q: [number, number, number, number] = cam ? [cam.quaternion.x, cam.quaternion.y, cam.quaternion.z, cam.quaternion.w] : [0.5, 0, 0, 0.866]
  return {
    bodies: d.geometry,
    appearance: computeAppearanceMap(d.features, d.rollback, d.geometry),
    hidden: useUi.getState().hiddenIds,
    settings,
    camera: { position: pos, quaternion: q },
    width: width ?? settings.width,
    height: height ?? settings.height,
  }
}

function begin(kind: 'still' | 'turntable'): AbortController | null {
  if (useRenderJob.getState().status === 'running') return null
  abort = new AbortController()
  useRenderJob.setState({ status: 'running', kind, progress: 0, text: 'Starting', error: null })
  return abort
}

const finish = (patch: Partial<JobState> = {}) => {
  abort = null
  useRenderJob.setState({ status: 'idle', kind: null, progress: 0, text: '', ...patch })
}

export function cancelJob() {
  abort?.abort()
}

export async function renderImage(): Promise<void> {
  const ac = begin('still')
  if (!ac) return
  const t0 = performance.now()
  try {
    const out = await renderStill(buildRequest(), {
      signal: ac.signal,
      onProgress: (progress, text) => useRenderJob.setState({ progress, text }),
    })
    const png = await canvasToPng(out.canvas)
    const prev = useRenderJob.getState().still
    if (prev) URL.revokeObjectURL(prev.url)
    const url = URL.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }))
    finish({ still: { url, width: out.canvas.width, height: out.canvas.height, engine: out.engine, note: out.note, png, seconds: (performance.now() - t0) / 1000 } })
  } catch (e) {
    if (e instanceof RenderCancelled) return finish()
    finish({ error: e instanceof Error ? e.message : String(e) })
  }
}

export function saveStill() {
  const s = useRenderJob.getState().still
  if (!s) return
  const name = (useDoc.getState().name || 'render').replace(/[^\w.-]+/g, '_')
  downloadFile(`${name}-render.png`, s.png, 'image/png')
  toast(`Saved ${name}-render.png`)
}

export async function renderTurntableVideo(): Promise<void> {
  const ac = begin('turntable')
  if (!ac) return
  const t0 = performance.now()
  try {
    const t = useRenderSettings.getState().s.turntable
    const bytes = await renderTurntable(buildRequest(t.width, t.height), {
      signal: ac.signal,
      onProgress: (progress, text) => useRenderJob.setState({ progress, text }),
    })
    finish({ video: { bytes, seconds: (performance.now() - t0) / 1000 } })
    const name = (useDoc.getState().name || 'turntable').replace(/[^\w.-]+/g, '_')
    downloadFile(`${name}-turntable.webm`, bytes, 'video/webm')
    toast(`Saved ${name}-turntable.webm`)
  } catch (e) {
    if (e instanceof RenderCancelled) return finish()
    finish({ error: e instanceof Error ? e.message : String(e) })
  }
}
