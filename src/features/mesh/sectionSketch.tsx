/**
 * Mesh Section Sketch: the outline a plane cuts out of a mesh body becomes a real sketch (lines, arcs and circles you can dimension,
 * edit and extrude), placed on the plane. The dialog previews the curves in the viewport; OK adds an ordinary Sketch step to the timeline.
 */
import { useEffect, useMemo } from 'react'
import { Line } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { create } from 'zustand'
import { Cardholder } from '@phosphor-icons/react'
import { resolveParams } from '@/doc/params'
import { RefReport } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import { getKernel } from '@/kernel/client'
import { bbox, type Vec3 } from '@/kernel/types'
import { insertImported, type Imp } from '@/sketch/importers'
import { emptyModel } from '@/sketch/types'
import { planeFromNormal, toLocal, toWorld } from '@/sketch/plane'
import type { PlaneDef, Vec2 } from '@/sketch/types'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { resetManip } from '@/viewport/preview'
import { clearHandles } from '../handleKit'
import { liveRefEnv } from '../modeling-tools/geo'
import { createRunner } from '../previewKit'
import { fitLoop, shapePoints } from './sectionFit'
import { bodiesParam } from './kit'
import { planeParams, planeEq, resolveCutPlane, showPlaneHandles, AXES } from './plane'

export const sectionSketchSchema: ParamSchema = {
  id: 'meshSectionSketch',
  title: 'Mesh Section Sketch',
  params: [
    bodiesParam,
    ...planeParams,
    { type: 'number', key: 'tolerance', label: 'Fit tolerance', unit: 'mm', min: 0.001, step: 0.01, default: 0.05, help: 'How far the sketch curves may stray from the outline of the mesh, in mm. Smaller keeps more detail and makes more curves.' },
  ],
}

/** The curves of the preview, as world polylines. */
export const useSectionPreview = create<{ lines: Vec3[][] }>(() => ({ lines: [] }))

export interface SectionResult { plane: PlaneDef; shapes: Imp[]; outlines: number }

/** Cut the bodies with the plane of the values and fit the outlines. Throws a readable error when nothing is cut. */
export async function sectionOf(p: ParamValues, bodyIds: string[]): Promise<SectionResult> {
  const env = liveRefEnv()
  const cp = await resolveCutPlane(p, env, new RefReport())
  const { normal, offset } = planeEq(cp)
  const plane = planeFromNormal(cp.origin, cp.normal)
  const bodies = bodyIds.map((id) => env.bodies.find((b) => b.id === id)).filter((b) => b && b.kind === 'mesh')
  if (!bodies.length) throw new Error('Select a mesh body to cut')
  const shapes: Imp[] = []
  let outlines = 0
  for (const b of bodies) {
    const loops = (await getKernel().call('meshSection', { key: b!.key, normal, offset })) as { points: Vec3[]; closed: boolean }[]
    for (const l of loops) {
      const pts = l.points.map((w) => toLocal(plane, w))
      const fit = fitLoop(pts, l.closed, (p.tolerance as number) || 0.05)
      if (fit.length) { shapes.push(...fit); outlines++ }
    }
  }
  if (!shapes.length) throw new Error('The plane does not cut through the mesh')
  return { plane, shapes, outlines }
}

const idsOf = (v: ParamValues): string[] => ((v.bodies as string[]) ?? []).map((s) => { try { return (JSON.parse(s) as { bodyId: string }).bodyId } catch { return s } })

/** Ribbon / palette entry. */
export function startSectionSketch() {
  const ui = useUi.getState()
  ui.inspector?.onCancel()
  const geometry = useDoc.getState().geometry
  const meshes = geometry.filter((b) => b.kind === 'mesh')
  if (!meshes.length) return toast('There is no mesh body to cut', 'error')
  let ids = [...new Set(ui.selection.map((r) => r.id))].filter((id) => meshes.some((b) => b.id === id))
  if (!ids.length && meshes.length === 1) ids = [meshes[0].id]
  const first = meshes.find((b) => b.id === ids[0]) ?? meshes[0]
  const bb = bbox(first.mesh.positions)
  // the plane starts through the middle of the body, so the first section already shows something
  let start: ParamValues = { bodies: ids, plane: [], axis: 'Z', offset: +((bb.min[2] + bb.max[2]) / 2).toFixed(3), tiltA: 0, tiltB: 0, tolerance: 0.05 }
  let cur = start
  const runner = createRunner(async (stale) => {
    try {
      const p = resolveParams(sectionSketchSchema, cur)
      const r = await sectionOf(p, idsOf(cur))
      if (stale()) return
      useSectionPreview.setState({ lines: r.shapes.map((s) => shapePoints(s).map((q: Vec2) => toWorld(r.plane, q))) })
      const kinds = { line: 0, arc: 0, circle: 0 } as Record<string, number>
      for (const s of r.shapes) kinds[s.k] = (kinds[s.k] ?? 0) + 1
      useUi.setState({ inspectorNotice: `${r.outlines} outline${r.outlines === 1 ? '' : 's'}: ${[kinds.line && `${kinds.line} lines`, kinds.arc && `${kinds.arc} arcs`, kinds.circle && `${kinds.circle} circles`].filter(Boolean).join(', ')}` })
    } catch (e) {
      if (stale()) return
      useSectionPreview.setState({ lines: [] })
      useUi.setState({ inspectorNotice: e instanceof Error ? e.message : String(e) })
    }
    try {
      const p = resolveParams(sectionSketchSchema, cur)
      const list = idsOf(cur).map((id) => geometry.find((b) => b.id === id)).filter((b): b is NonNullable<typeof b> => !!b)
      await showPlaneHandles(p, list, liveRefEnv(), (patch) => { cur = { ...cur, ...patch }; reopen(cur) })
    } catch { clearHandles() }
  }, 200)
  const close = () => {
    runner.dispose()
    useSectionPreview.setState({ lines: [] })
    resetManip()
    clearHandles()
    useUi.setState({ inspectorNotice: null })
    useUi.getState().closeInspector()
    useUi.getState().setActiveTool(null)
  }
  const session = (values: ParamValues) => ({
    schema: sectionSketchSchema,
    values,
    formId: 7700,
    get latest() { return cur },
    onChange: (v: ParamValues) => { cur = v; runner.schedule() },
    onOk: (v: ParamValues) => {
      void (async () => {
        try {
          const p = resolveParams(sectionSketchSchema, v)
          if (!idsOf(v).length) throw new Error('Select a mesh body to cut')
          const r = await sectionOf(p, idsOf(v))
          const model = emptyModel()
          insertImported(model, { shapes: r.shapes, notes: [] })
          close()
          useDoc.getState().addFeature('sketch', { sketch: JSON.stringify({ plane: r.plane, face: null, model }) }, 'Section Sketch')
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), 'error')
        }
      })()
    },
    onCancel: close,
  })
  const reopen = (v: ParamValues) => { start = v; useUi.getState().openInspector(session(v)) }
  ui.setActiveTool('mesh.sectionSketch')
  ui.openInspector(session(start))
  runner.schedule()
}

/** The section curves of the open dialog, drawn over the mesh. Mounted inside the Canvas. */
export function MeshSectionPreview() {
  const lines = useSectionPreview((s) => s.lines)
  const { invalidate } = useThree()
  useEffect(() => { invalidate() }, [lines, invalidate])
  const shown = useMemo(() => lines.filter((l) => l.length >= 2), [lines])
  if (!shown.length) return null
  return (
    <group renderOrder={8}>
      {shown.map((pts, i) => <Line key={i} points={pts} color="#27d3e6" lineWidth={2.4} depthTest={false} transparent raycast={() => null} />)}
    </group>
  )
}

export const SECTION_ICON = Cardholder
void AXES
