/** The sliced toolpaths in the 3D canvas: replaces the bodies while previewing, sitting where the bodies were. */
import { useEffect, useState } from 'react'
import { useThree } from '@react-three/fiber'
import { transfer, wrap } from 'comlink'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { DEBUG_HANDLE } from '@/app/flags'
import { setPreview, useSlice } from '../engine/sliceStore'
import type { SliceOutput } from '../engine/types'
import { assignFilaments, type GcodeScan } from './gcodeFilaments'
import { bedOriginFromBounds, countVisible, roleStats, type ColorMode } from './data'
import { extrasOf, resetPreview, setPlaying, setScrub, usePreview } from './previewStore'
import { ToolpathRenderer } from './renderer'

export const PREVIEW_TOOL = 'print.preview'

/** The single live renderer, for the test hook and the performance probes. */
let current: ToolpathRenderer | null = null
export const currentRenderer = () => current

/** Where bed (0,0,0) is in the world: the slice's own answer (a dev slice without one falls back to the bed centered under the bodies). */
function originOf(bed: [number, number] | null): [number, number, number] {
  const given = useSlice.getState().bedOrigin
  if (given) return given
  const hidden = useUi.getState().hiddenIds
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const b of useDoc.getState().geometry) {
    if (hidden[b.id] || b.surface) continue
    const p = b.mesh.positions
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { if (p[i + k] < lo[k]) lo[k] = p[i + k]; if (p[i + k] > hi[k]) hi[k] = p[i + k] }
  }
  if (!isFinite(lo[0])) return [0, 0, 0]
  return bedOriginFromBounds(lo, hi, bed ?? [256, 256])
}

/** Layer height for beads whose height code is unknown: the typical gap between layers. */
const layerHeightOf = (z: Float32Array) => (z.length > 1 ? Math.max(0.04, (z[z.length - 1] - z[0]) / (z.length - 1)) : z[0] || 0.2)

async function scanGcode(r: SliceOutput): Promise<GcodeScan | null> {
  if (!r.gcode?.length) return null
  const worker = new Worker(new URL('./scan.worker.ts', import.meta.url), { type: 'module' })
  try {
    const api = wrap<{ scan: (g: Uint8Array) => GcodeScan }>(worker)
    const copy = r.gcode.slice()
    return await api.scan(transfer(copy, [copy.buffer]))
  } catch {
    return null
  } finally {
    worker.terminate()
  }
}

export function SlicePreviewLayer() {
  const preview = useSlice((s) => s.preview)
  const result = useSlice((s) => s.result)
  const bed = useSlice((s) => s.bed)
  const colors = useSlice((s) => s.filamentColors)
  const scene = useThree((s) => s.scene)
  const invalidate = useThree((s) => s.invalidate)
  const [renderer, setRenderer] = useState<ToolpathRenderer | null>(null)
  const tp = result?.toolpaths ?? null
  const active = preview && !!tp && tp.extrusions.count > 0
  const lo = usePreview((s) => s.lo)
  const hi = usePreview((s) => s.hi)
  const scrub = usePreview((s) => s.scrub)
  const mode = usePreview((s) => s.mode)
  const roleOff = usePreview((s) => s.roleOff)
  const filOff = usePreview((s) => s.filOff)
  const travel = usePreview((s) => s.travel)
  const playing = usePreview((s) => s.playing)

  // build on entering preview or on a new result, free on leaving
  useEffect(() => {
    if (!active || !result || !tp) return
    const extras = extrasOf(result)
    const org = originOf(bed)
    const stats = roleStats(tp, extras)
    resetPreview({
      layerCount: tp.layerCount, layerZ: Array.from(tp.layerZ), hasExtras: !!extras, roles: stats, filaments: null, range: null, segments: tp.extrusions.count,
    })
    const r = new ToolpathRenderer({
      toolpaths: tp, extras, filament: null, filamentColors: colors, origin: org, layerHeight: layerHeightOf(tp.layerZ),
    })
    r.onChange = invalidate
    current = r
    setRenderer(r)
    void r.build()
    let gone = false
    void scanGcode(result).then((scan) => {
      if (gone || !scan) return
      const n = Math.max(colors.length, ...scan.runs.map((x) => x.tool + 1), 1)
      if (scan.runs.length > 1) r.setFilament(assignFilaments(tp.extrusions.positions, tp.extrusions.count, scan.runs))
      const filaments = Array.from({ length: n }, (_, i) => ({ grams: scan.usedG?.[i] ?? null, mm: scan.usedMm?.[i] ?? null }))
      usePreview.setState((s) => (s.info ? { info: { ...s.info, filaments } } : {}))
    })
    return () => {
      gone = true
      r.dispose()
      if (current === r) current = null
      setRenderer(null)
      invalidate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, result])

  // the view follows the store
  useEffect(() => {
    if (!renderer || !tp) return
    const roleOn = renderer.roleNames.map((n) => !roleOff[n])
    const filOn: boolean[] = []
    for (let i = 0; i < 16; i++) filOn.push(!filOff[i])
    renderer.setState({ range: { lo, hi, scrub }, mode, roleOn, filOn, travel })
    if (mode !== 'feature' && mode !== 'filament') {
      const v = renderer.valuesFor(mode)
      usePreview.setState((s) => (s.info ? { info: { ...s.info, range: v ? { min: v.min, max: v.max } : null } } : {}))
    }
    invalidate()
  }, [renderer, tp, lo, hi, scrub, mode, roleOff, filOff, travel, invalidate])

  // the bodies step aside while previewing
  useEffect(() => {
    if (!active) return
    const names = ['bodies', 'print-paint-layer', 'print-analysis']
    const hiddenNow: { o: { visible: boolean }; was: boolean }[] = []
    const hide = () => {
      for (const n of names) {
        const o = scene.getObjectByName(n)
        if (o && !hiddenNow.some((h) => h.o === o)) hiddenNow.push({ o, was: o.visible })
        if (o) o.visible = false
      }
      invalidate()
    }
    hide()
    // bodies that rebuild while previewing (undo, a late tessellation) are hidden again
    const un = useDoc.subscribe(() => requestAnimationFrame(hide))
    return () => {
      un()
      for (const h of hiddenNow) h.o.visible = h.was
      invalidate()
    }
  }, [active, scene, invalidate])

  // the play button
  useEffect(() => {
    if (!playing || !tp) return
    const ls = tp.extrusions.layerStart
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const st = usePreview.getState()
      const segs = ls[Math.min(st.hi, ls.length - 2) + 1] - ls[Math.min(st.hi, ls.length - 2)]
      const seconds = Math.max(1.2, Math.min(9, segs / 900))
      const next = st.scrub + (now - last) / 1000 / seconds
      last = now
      if (next >= 1) { setScrub(1); setPlaying(false); return }
      setScrub(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, tp])

  // Esc or picking another tool leaves the preview: the preview is the active tool while it is on
  useEffect(() => {
    if (!preview) return
    if (useUi.getState().activeTool !== PREVIEW_TOOL) useUi.getState().setActiveTool(PREVIEW_TOOL)
    let seen = useUi.getState().activeTool
    const un = useUi.subscribe((s) => {
      if (s.activeTool === seen) return
      seen = s.activeTool
      if (s.activeTool !== PREVIEW_TOOL) { setPlaying(false); setPreview(false) }
    })
    return () => {
      un()
      if (useUi.getState().activeTool === PREVIEW_TOOL) useUi.getState().setActiveTool(null)
    }
  }, [preview])

  // test hook: the stores and what the renderer draws
  useEffect(() => {
    if (!DEBUG_HANDLE) return
    const w = window as unknown as { __caddy?: Record<string, unknown>; __caddyExtra?: Record<string, unknown> }
    const hook: Record<string, unknown> = {
      store: usePreview,
      slice: useSlice,
      stats: () => currentRenderer()?.stats() ?? null,
      /** segments that pass the current layer range and switches, counted on the CPU (what the GPU should draw) */
      expected: () => {
        const r = useSlice.getState().result?.toolpaths
        const rd = currentRenderer()
        if (!r || !rd) return null
        const st = usePreview.getState()
        return countVisible(r, { lo: st.lo, hi: st.hi, scrub: st.scrub }, rd.roleNames.map((n) => !st.roleOff[n]))
      },
      origin: () => currentRenderer()?.group.position.toArray() ?? null,
      mode: (m: ColorMode) => usePreview.setState({ mode: m }),
    }
    // the debug handle is built after the first render, so it is offered both ways
    w.__caddyExtra = { ...w.__caddyExtra, slicePreview: hook }
    if (w.__caddy) w.__caddy.slicePreview = hook
    void import('./devSlice').then((m) => { hook.devSlice = m.devSlice; hook.devFake = m.devFake })
  }, [])

  if (!active) return null
  return (
    <>
      {renderer && <primitive object={renderer.group} />}
    </>
  )
}
