/** The sheet on screen: pan, zoom, select, drag, and the pointer side of the tools. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDoc } from '@/doc/store'
import type { V2 } from '@/kernel/drawing-geom'
import { listComponents } from './components'
import { editDim, editNote, editView } from './forms'
import { hitOwner, viewAt } from './pick'
import { sheetDims } from './sheets'
import { buildSheet, type SheetOutput } from './sheetprims'
import { moveViewIn, useDrawing, type Selection } from './store'
import { LINE_STYLES } from './styles'
import { toolClick, toolMove, useTool } from './tools'
import type { LineStyle, Prim, Sheet } from './types'
import { refreshGeoms, useViewGeoms } from './views'
import { pathData } from './export/svg'

export interface Cam { cx: number; cy: number; zoom: number }

/** What the toolbar and the browser specs can do to the camera of the open sheet. */
export interface CamHandle { fit: () => void; zoomBy: (f: number) => void; /** zoom to a rectangle of the sheet (mm) */ zoomRect: (x0: number, y0: number, x1: number, y1: number) => void }
export const camHandle: { current: CamHandle | null } = { current: null }

/** Pixels per mm that fit the sheet in a w x h pixel area with some air around it. */
export function fitCam(sheet: Sheet, w: number, h: number): Cam {
  const d = sheetDims(sheet)
  const zoom = Math.max(0.2, Math.min((w - 48) / d.w, (h - 48) / d.h))
  return { cx: d.w / 2, cy: d.h / 2, zoom }
}

const ownerSel = (o: string): Selection => {
  const [k, id] = o.split(':')
  return k === 'view' ? { kind: 'view', id } : k === 'dim' ? { kind: 'dim', id } : k === 'note' ? { kind: 'note', id } : null
}
const selOwner = (s: Selection) => (s ? `${s.kind}:${s.id}` : null)

/** The primitives of the active sheet, rebuilt when the drawing, the model or a view's geometry changes. */
export function useSheetOutput(sheet: Sheet | undefined): SheetOutput | null {
  const doc = useDrawing((s) => s.doc)
  const bodies = useDoc((s) => s.geometry)
  const geoms = useViewGeoms((s) => s.geoms)
  const names = useDoc((s) => s.bodyNames)
  return useMemo(() => {
    if (!sheet) return null
    try {
      return buildSheet({ doc, sheet, bodies, geoms, parts: listComponents() })
    } catch (e) {
      console.warn('[drawing] could not build the sheet', e)
      return null
    }
    // names: the parts list shows body names
  }, [doc, sheet, bodies, geoms, names])
}

const strokeFor = (s: LineStyle) => LINE_STYLES[s]

function Layer({ prims, h, color, extra = 0, only }: { prims: Prim[]; h: number; color?: string; extra?: number; only?: string | null }) {
  const groups = new Map<LineStyle, { d: string; fill: string }>()
  const texts: Prim[] = []
  for (const p of prims) {
    if (only !== undefined && p.owner !== only) continue
    if (p.k === 'text') { texts.push(p); continue }
    if (p.pick || p.pts.length < 4) continue
    const key = p.style
    const g = groups.get(key) ?? groups.set(key, { d: '', fill: '' }).get(key)!
    if (p.fill === 'solid') g.fill += pathData(p.pts, h, true)
    else g.d += pathData(p.pts, h, p.closed)
  }
  return (
    <>
      {[...groups].map(([style, g]) => {
        const spec = strokeFor(style)
        const stroke = color ?? '#000'
        return (
          <g key={style}>
            {g.d && <path d={g.d} fill="none" stroke={stroke} strokeWidth={spec.width + extra} strokeDasharray={spec.dash.length ? spec.dash.join(' ') : undefined} strokeLinecap="round" strokeLinejoin="round" />}
            {g.fill && <path d={g.fill} fill={stroke} stroke={stroke} strokeWidth={extra} strokeLinejoin="round" />}
          </g>
        )
      })}
      {texts.map((p, i) => {
        if (p.k !== 'text') return null
        return (
          <text key={i} x={p.x} y={h - p.y} fontSize={p.size} textAnchor={p.anchor} fontWeight={p.bold ? 700 : 400} fill={color ?? '#000'} fontFamily="Inter, system-ui, sans-serif"
            transform={p.rot ? `rotate(${-p.rot} ${p.x} ${h - p.y})` : undefined} style={{ userSelect: 'none' }}>{p.text}</text>
        )
      })}
    </>
  )
}

export function Canvas({ sheet, out }: { sheet: Sheet; out: SheetOutput | null }) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [cam, setCam] = useState<Cam>({ cx: 150, cy: 100, zoom: 2 })
  const [hover, setHover] = useState<string | null>(null)
  const selection = useDrawing((s) => s.selection)
  const tool = useTool((s) => s.tool)
  const preview = useTool((s) => s.preview)
  const marker = useTool((s) => s.marker)
  const target = useTool((s) => s.target)
  const geoms = useViewGeoms((s) => s.geoms)
  const drag = useRef<{ kind: 'pan'; sx: number; sy: number; cam: Cam } | { kind: 'move'; base: ReturnType<typeof useDrawing.getState>['doc']; start: V2; sel: NonNullable<Selection>; orig: V2 } | null>(null)
  const fitted = useRef('')

  const d = sheetDims(sheet)
  const H = d.h

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // fit when the sheet or its size changes
  useEffect(() => {
    const key = `${sheet.id}|${sheet.size}|${sheet.portrait}`
    if (fitted.current === key || size.w < 100) return
    fitted.current = key
    setCam(fitCam(sheet, size.w, size.h))
  }, [sheet, size])

  const bodies = useDoc((s) => s.geometry)
  const sheets = useDrawing((s) => s.doc.sheets)
  useEffect(() => { void refreshGeoms(sheets) }, [sheets, bodies])

  useEffect(() => {
    camHandle.current = {
      fit: () => setCam(fitCam(sheet, size.w, size.h)),
      zoomBy: (f) => setCam((c) => ({ ...c, zoom: Math.max(0.2, Math.min(60, c.zoom * f)) })),
      zoomRect: (x0, y0, x1, y1) => setCam({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, zoom: Math.max(0.2, Math.min(60, Math.min(size.w / Math.max(x1 - x0, 1), size.h / Math.max(y1 - y0, 1)) * 0.9)) }),
    }
    return () => { camHandle.current = null }
  }, [sheet, size])

  // screen px (relative to the box) <-> sheet mm (y up)
  const toSheet = useCallback((px: number, py: number): V2 => [cam.cx + (px - size.w / 2) / cam.zoom, cam.cy - (py - size.h / 2) / cam.zoom], [cam, size])
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top] as const
  }

  const onWheel = (e: React.WheelEvent) => {
    const [px, py] = local(e)
    const before = toSheet(px, py)
    const f = Math.exp(-e.deltaY * 0.0015)
    const zoom = Math.max(0.2, Math.min(60, cam.zoom * f))
    // keep the point under the pointer where it is
    setCam({ zoom, cx: before[0] - (px - size.w / 2) / zoom, cy: before[1] + (py - size.h / 2) / zoom })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const [px, py] = local(e)
    const pt = toSheet(px, py)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam }
      return
    }
    if (e.button === 2) return
    if (tool) {
      void toolClick(pt, cam.zoom)
      return
    }
    if (!out) return
    const owner = hitOwner(out.prims, pt[0], pt[1], 4 / cam.zoom) ?? (viewAt(sheet, geoms, pt[0], pt[1], 0) ? 'view:' + viewAt(sheet, geoms, pt[0], pt[1], 0)!.id : null)
    const sel = owner ? ownerSel(owner) : null
    useDrawing.getState().select(sel)
    if (!sel) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, cam }
      return
    }
    const base = useDrawing.getState().doc
    const orig: V2 = sel.kind === 'view' ? sheet.views.find((v) => v.id === sel.id)!.pos : sel.kind === 'dim' ? [sheet.dims.find((x) => x.id === sel.id)!.offset, 0] : (() => {
      const n = sheet.notes.find((x) => x.id === sel.id)!
      return n.kind === 'leader' ? n.pts[n.pts.length - 1] : (n as { pos: V2 }).pos
    })()
    drag.current = { kind: 'move', base, start: pt, sel, orig }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const [px, py] = local(e)
    const pt = toSheet(px, py)
    const dr = drag.current
    if (dr?.kind === 'pan') {
      setCam({ ...dr.cam, cx: dr.cam.cx - (e.clientX - dr.sx) / cam.zoom, cy: dr.cam.cy + (e.clientY - dr.sy) / cam.zoom })
      return
    }
    if (dr?.kind === 'move') {
      const dx = pt[0] - dr.start[0], dy = pt[1] - dr.start[1]
      if (Math.hypot(dx, dy) * cam.zoom < 3 && useDrawing.getState().doc === dr.base) return
      const { sel, orig } = dr
      useDrawing.getState().preview(dr.base, (doc) => {
        if (sel.kind === 'view') moveViewIn(doc, sheet.id, sel.id, [orig[0] + dx, orig[1] + dy])
        else if (sel.kind === 'dim') {
          const dim = doc.sheets.find((s) => s.id === sheet.id)?.dims.find((x) => x.id === sel.id)
          const g = out?.drags[sel.id]
          if (dim && g) dim.offset = orig[0] + g[0] * dx + g[1] * dy
        } else {
          const n = doc.sheets.find((s) => s.id === sheet.id)?.notes.find((x) => x.id === sel.id)
          if (!n) return
          if (n.kind === 'leader') n.pts[n.pts.length - 1] = [orig[0] + dx, orig[1] + dy]
          else (n as { pos: V2 }).pos = [orig[0] + dx, orig[1] + dy]
        }
      })
      return
    }
    if (tool) toolMove(pt, cam.zoom)
    else {
      useTool.setState({ cursor: pt })
      if (out) setHover(hitOwner(out.prims, pt[0], pt[1], 4 / cam.zoom))
    }
  }

  const onPointerUp = () => {
    const dr = drag.current
    drag.current = null
    if (dr?.kind === 'move') useDrawing.getState().commit(dr.base)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool || !out) return
    const [px, py] = local(e)
    const pt = toSheet(px, py)
    const owner = hitOwner(out.prims, pt[0], pt[1], 4 / cam.zoom)
    const sel = owner ? ownerSel(owner) : null
    if (!sel) return
    if (sel.kind === 'view') { const v = sheet.views.find((x) => x.id === sel.id); if (v) editView(sheet.id, v) }
    else if (sel.kind === 'dim') { const x = sheet.dims.find((q) => q.id === sel.id); if (x) editDim(sheet.id, x) }
    else { const n = sheet.notes.find((q) => q.id === sel.id); if (n) editNote(sheet.id, n) }
  }

  const so = selOwner(selection)
  const vbW = size.w / cam.zoom, vbH = size.h / cam.zoom
  const vx = cam.cx - vbW / 2, vy = H - cam.cy - vbH / 2
  const targetView = target ? sheet.views.find((v) => v.id === target) : null
  const targetRect = targetView ? (() => {
    const g = geoms[sheet.id + '/' + targetView.id]
    if (!g?.bounds) return null
    const a = [targetView.pos[0] + (g.bounds[0] - targetView.anchor[0]) * targetView.scale, targetView.pos[1] + (g.bounds[1] - targetView.anchor[1]) * targetView.scale]
    const b = [targetView.pos[0] + (g.bounds[2] - targetView.anchor[0]) * targetView.scale, targetView.pos[1] + (g.bounds[3] - targetView.anchor[1]) * targetView.scale]
    return { x: Math.min(a[0], b[0]) - 3, y: H - Math.max(a[1], b[1]) - 3, w: Math.abs(b[0] - a[0]) + 6, h: Math.abs(b[1] - a[1]) + 6 }
  })() : null

  return (
    <div
      ref={box} className="dw-canvas" data-testid="drawing-canvas" data-tool={tool ?? ''}
      onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={onDoubleClick}
      onContextMenu={(e) => { e.preventDefault(); if (tool) void import('./tools').then((t) => t.endTool()) }}
      style={{ cursor: tool ? 'crosshair' : 'default' }}
    >
      <svg width={size.w} height={size.h} viewBox={`${vx} ${vy} ${vbW} ${vbH}`} data-testid="drawing-svg" data-zoom={cam.zoom} data-h={H}>
        <rect x={3 / cam.zoom} y={3 / cam.zoom} width={d.w} height={d.h} fill="rgba(0,0,0,0.35)" />
        <rect x={0} y={0} width={d.w} height={d.h} fill="#ffffff" data-testid="drawing-paper" />
        {out && <Layer prims={out.prims} h={H} />}
        {out && so && <Layer prims={out.prims} h={H} color="#1f9bb5" extra={0.5} only={so} />}
        {out && hover && hover !== so && !tool && <Layer prims={out.prims} h={H} color="#5fb3c4" extra={0.25} only={hover} />}
        {targetRect && <rect x={targetRect.x} y={targetRect.y} width={targetRect.w} height={targetRect.h} fill="rgba(31,155,181,0.08)" stroke="#1f9bb5" strokeWidth={0.4} strokeDasharray="2 1.5" />}
        {preview.length > 0 && <Layer prims={preview} h={H} color="#d98a1f" extra={0.15} />}
        {marker && <circle cx={marker[0]} cy={H - marker[1]} r={5 / cam.zoom} fill="none" stroke="#d98a1f" strokeWidth={1.6 / cam.zoom} data-testid="drawing-snap" />}
      </svg>
    </div>
  )
}
