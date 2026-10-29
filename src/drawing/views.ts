/** View geometry: hidden line removal results per view (cached), and the placement maths of views on a sheet. */
import { create } from 'zustand'
import { useDoc } from '@/doc/store'
import { getKernel } from '@/kernel/client'
import type { HlrResult } from '@/kernel/drawing-ops'
import {
  clipPolyToCircle, ORIENTATIONS, polyBounds, projectedOrientation, sectionPlane, type Poly2, type Side, type V2,
} from '@/kernel/drawing-geom'
import { cross3, dot3 } from '@/kernel/print-geom'
import { itemExists, itemMatrix } from './components'
import type { DrawingView, Sheet } from './types'

export interface ViewGeom {
  key: string
  visible: Poly2[]
  hidden: Poly2[]
  tangent: Poly2[]
  /** section faces: loops (outer first), and the index in the view's `items` of the body each came from */
  cut: Poly2[][]
  cutBody: number[]
  /** view plane bounds of the lines */
  bounds: [number, number, number, number] | null
}

interface GeomState {
  geoms: Record<string, ViewGeom>
  pending: Record<string, string>
  errors: Record<string, string>
}
export const useViewGeoms = create<GeomState>(() => ({ geoms: {}, pending: {}, errors: {} }))

/** world -> sheet for a point of the view plane */
export const toSheet = (v: DrawingView, p: V2): V2 => [v.pos[0] + (p[0] - v.anchor[0]) * v.scale, v.pos[1] + (p[1] - v.anchor[1]) * v.scale]
export const fromSheet = (v: DrawingView, p: V2): V2 => [v.anchor[0] + (p[0] - v.pos[0]) / v.scale, v.anchor[1] + (p[1] - v.pos[1]) / v.scale]

/** Orientation of a view: a section view always follows its parent and cut line. */
export function viewAxes(v: DrawingView, sheet: Pick<Sheet, 'views'>): { eye: DrawingView['eye']; right: DrawingView['right'] } {
  if (v.kind === 'section' && v.cut && v.parentId) {
    const p = sheet.views.find((x) => x.id === v.parentId)
    if (p) {
      const pl = sectionPlane(p.eye, p.right, v.cut.a, v.cut.b, v.cut.flip)
      return { eye: pl.secEye, right: pl.secRight }
    }
  }
  return { eye: v.eye, right: v.right }
}

export const geomKey = (v: DrawingView, sheet: Pick<Sheet, 'views'>, bodyKeys: string): string => {
  const ax = viewAxes(v, sheet)
  return JSON.stringify([bodyKeys, ax.eye.map((x) => +x.toFixed(6)), ax.right.map((x) => +x.toFixed(6)), v.cut ? [v.cut.a, v.cut.b, v.cut.flip] : null, v.detail ?? null, v.parentId ?? null])
}

function itemsKey(v: DrawingView): { keys: { key: string; matrix?: number[] }[]; sig: string } | null {
  const bodies = useDoc.getState().geometry
  const keys: { key: string; matrix?: number[] }[] = []
  for (const it of v.items) {
    const b = bodies.find((x) => x.id === it.bodyId)
    if (!b || b.kind !== 'brep' || !itemExists(it)) continue
    keys.push({ key: b.key, matrix: itemMatrix(it) })
  }
  return keys.length ? { keys, sig: JSON.stringify(keys) } : null
}

/** Run hidden line removal for a view (no cache). Detail views are cut from their parent's geometry. */
export async function computeGeom(v: DrawingView, sheet: Pick<Sheet, 'views'>, parent?: ViewGeom): Promise<ViewGeom | null> {
  const ax = viewAxes(v, sheet)
  const key = geomKey(v, sheet, itemsKey(v)?.sig ?? '')
  if (v.kind === 'detail' && v.detail) {
    if (!parent) return null
    const c = v.detail.c, r = v.detail.r
    const clip = (list: Poly2[]) => list.flatMap((p) => clipPolyToCircle(p, c, r))
    const g: ViewGeom = { key, visible: clip(parent.visible), hidden: clip(parent.hidden), tangent: clip(parent.tangent), cut: parent.cut, cutBody: parent.cutBody, bounds: null }
    g.bounds = [c[0] - r, c[1] - r, c[0] + r, c[1] + r]
    return g
  }
  const ik = itemsKey(v)
  if (!ik) return null
  let section: { origin: [number, number, number]; normal: [number, number, number] } | undefined
  if (v.kind === 'section' && v.cut && v.parentId) {
    const p = sheet.views.find((x) => x.id === v.parentId)
    if (p) {
      const pl = sectionPlane(p.eye, p.right, v.cut.a, v.cut.b, v.cut.flip)
      section = { origin: pl.origin, normal: pl.normal }
    }
  }
  const r = (await getKernel().call('drawingHlr', { items: ik.keys, eye: ax.eye, right: ax.right, section })) as HlrResult
  return { key, visible: r.visible, hidden: r.hidden, tangent: r.tangent, cut: r.cut, cutBody: r.cutBody, bounds: r.bounds ?? polyBounds([...r.visible, ...r.hidden]) }
}

const running = new Set<string>()

/**
 * Bring the cached geometry of every view of the sheets up to date. Cheap when nothing changed; a view whose bodies,
 * orientation or cut line changed is recomputed. Resolves when all of them are done.
 */
export async function refreshGeoms(sheets: Sheet[]): Promise<void> {
  for (const sheet of sheets) {
    // parents first so details can use them
    const order = [...sheet.views].sort((a, b) => (a.kind === 'detail' ? 1 : 0) - (b.kind === 'detail' ? 1 : 0))
    for (const v of order) {
      const tag = sheet.id + '/' + v.id
      const st = useViewGeoms.getState()
      const want = geomKey(v, sheet, itemsKey(v)?.sig ?? '') + (v.kind === 'detail' ? '|' + (st.geoms[sheet.id + '/' + v.parentId]?.key ?? '') : '')
      if (st.geoms[tag] && st.geoms[tag].key + (v.kind === 'detail' ? '|' + (st.geoms[sheet.id + '/' + v.parentId]?.key ?? '') : '') === want) continue
      if (running.has(tag + want)) continue
      running.add(tag + want)
      try {
        const g = await computeGeom(v, sheet, v.parentId ? useViewGeoms.getState().geoms[sheet.id + '/' + v.parentId] : undefined)
        useViewGeoms.setState((s) => {
          const geoms = { ...s.geoms }
          const errors = { ...s.errors }
          if (g) { geoms[tag] = g; delete errors[tag] } else { delete geoms[tag]; errors[tag] = 'Nothing to show: the bodies of this view are gone or are meshes' }
          return { geoms, errors }
        })
      } catch (e) {
        useViewGeoms.setState((s) => ({ errors: { ...s.errors, [tag]: e instanceof Error ? e.message : String(e) } }))
      } finally {
        running.delete(tag + want)
      }
    }
  }
}

export const geomOf = (sheetId: string, viewId: string): ViewGeom | undefined => useViewGeoms.getState().geoms[sheetId + '/' + viewId]

// ---------------------------------------------------------------- creating views

export const SIDE_NAMES: Record<Side, string> = { right: 'Right side', left: 'Left side', above: 'Above', below: 'Below' }

/** Orientation of a new base view from an orientation name. */
export function orientationOf(name: string): { eye: DrawingView['eye']; right: DrawingView['right'] } {
  const o = ORIENTATIONS[name] ?? ORIENTATIONS.front
  return { eye: o.eye, right: o.right }
}

export function projectedAxes(parent: DrawingView, side: Side, projection: 'first' | 'third') {
  return projectedOrientation(parent.eye, parent.right, side, projection)
}

/** Which standard view a pair of axes is, if any. */
export function orientationName(eye: DrawingView['eye'], right: DrawingView['right']): string {
  for (const [k, o] of Object.entries(ORIENTATIONS)) {
    if (o.eye.every((x, i) => Math.abs(x - eye[i]) < 1e-6) && o.right.every((x, i) => Math.abs(x - right[i]) < 1e-6)) return k
  }
  return 'custom'
}

/** The next free label letter (A, B, C ... skipping the ones used by section and detail views of the sheet). */
export function nextLetter(sheet: Pick<Sheet, 'views'>): string {
  const used = new Set(sheet.views.flatMap((v) => [v.cut?.letter, v.detail?.letter]).filter(Boolean) as string[])
  for (let i = 0; i < 26; i++) {
    const l = String.fromCharCode(65 + i)
    if (!used.has(l) && !'IOQSXZ'.includes(l)) return l
  }
  return 'A'
}

/** Sheet size of a view at its scale, from its geometry. */
export function viewSheetSize(v: DrawingView, g: ViewGeom | undefined): { w: number; h: number } {
  if (!g?.bounds) return { w: 0, h: 0 }
  const [x0, y0, x1, y1] = g.bounds
  return { w: (x1 - x0) * v.scale, h: (y1 - y0) * v.scale }
}

/**
 * Direction, in the parent view's plane (x right, y up), in which a section view looks at its cut line (the way the arrows
 * on the cut line point). The section view is placed on that side in third angle projection and on the opposite one in first angle.
 */
export function sightInPlane(pax: { eye: DrawingView['eye']; right: DrawingView['right'] }, normal: DrawingView['eye']): V2 {
  const y = cross3(pax.eye, pax.right)
  return [-dot3(normal, pax.right), -dot3(normal, y)]
}
