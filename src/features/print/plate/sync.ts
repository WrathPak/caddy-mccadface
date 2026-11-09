/** Keeps the viewport's idea of where the bodies stand (usePlateXf) in step with the plate, frames the bed on entering, and the tool keys. */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { viewportBus } from '@/viewport/bus'
import { usePlateXf } from '@/viewport/plateXf'
import { useSlice } from '../engine/sliceStore'
import { arrangeParts, autoOrientParts, centreParts } from './ops'
import { frameBed } from './frame'
import { useBed, usePlate, usePlateCompute, usePlateModel, useStage } from './store'

/** Tools that work on the CAD geometry where it is: the plate steps aside while their dialog is open. */
const CAD_SPACE_TOOLS = new Set(['split', 'hollow'])

/** The Print workspace shows its plate: not for an assembly (those are laid out when sliced). */
export function usePlateActive(): boolean {
  const workspace = useUi((s) => s.workspace)
  const tool = useUi((s) => s.inspector?.schema.id)
  const assembly = useDoc((s) => s.assembly.occurrences.length > 0)
  return workspace === 'print' && !assembly && !(tool && CAD_SPACE_TOOLS.has(tool))
}

export function usePlateSync() {
  const on = usePlateActive()
  usePlateCompute(on)
  const plate = usePlateModel()
  useLayoutEffect(() => {
    if (!on) {
      if (usePlateXf.getState().worlds) usePlateXf.setState({ worlds: null, boxes: null, bad: {} })
      return
    }
    const worlds: Record<string, number[]> = {}
    const boxes: Record<string, { lo: [number, number, number]; hi: [number, number, number] }> = {}
    const bad: Record<string, true> = {}
    for (const p of plate.list) {
      worlds[p.id] = p.m
      boxes[p.id] = { lo: p.lo, hi: p.hi }
      if (p.status !== 'ok') bad[p.id] = true
    }
    usePlateXf.setState({ worlds, boxes, bad })
  }, [on, plate])
  useEffect(() => () => usePlateXf.setState({ worlds: null, boxes: null, bad: {} }), [])
}

/** Fit the view to the bed when Print opens, when the printer or the stage changes, and on Frame All / Reset view. */
export function useFrameBed() {
  const workspace = useUi((s) => s.workspace)
  const bed = useBed()
  const stage = useStage()
  const key = `${bed.hi[0] - bed.lo[0]}x${bed.hi[1] - bed.lo[1]}x${bed.height}|${stage}`
  const last = useRef('')
  const bedRef = useRef(bed)
  bedRef.current = bed
  useEffect(() => {
    if (workspace !== 'print') { last.current = ''; return }
    if (last.current === key) return
    last.current = key
    const t = setTimeout(() => frameBed(bedRef.current, stage), 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, key])
  useEffect(() => {
    if (workspace !== 'print') return
    const again = () => setTimeout(() => frameBed(bedRef.current, useSlice.getState().preview ? 'preview' : 'prepare'), 0)
    const offs = [viewportBus.on('frame', again), viewportBus.on('resetView', again)]
    return () => offs.forEach((o) => o())
  }, [workspace])
}

/** M move, R rotate, L lay on face, O auto orient, A arrange, C center. */
export function usePlateKeys(active: boolean) {
  const preview = useSlice((s) => s.preview)
  const enabled = useMemo(() => active && !preview, [active, preview])
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (useUi.getState().inspector || useUi.getState().sketchMode) return
      const k = e.key.toLowerCase()
      const map: Record<string, () => void> = {
        m: () => usePlate.setState({ tool: 'move' }),
        r: () => usePlate.setState({ tool: 'rotate' }),
        l: () => usePlate.setState({ tool: 'face' }),
        o: () => void autoOrientParts(),
        a: () => void arrangeParts(),
        c: () => void centreParts(),
      }
      if (!map[k] || e.shiftKey) return
      e.preventDefault(); e.stopPropagation()
      map[k]()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled])
}
