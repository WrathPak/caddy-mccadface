/** Sketch overlay extras: previews of the newer tools, spline control polygons and tangent handles, ellipse axes. */
import { useMemo } from 'react'
import { useVpColors } from '@/viewport/colors'
import { Segments, toPairs } from './SketchOverlay'
import { pos } from './model'
import { useSketch } from './store'
import { useToolPreview } from './toolsUi'
import type { Vec2 } from './types'

export function ToolsOverlay({ wpp }: { wpp: number }) {
  const colors = useVpColors()
  const model = useSketch((s) => s.model)
  const prev = useToolPreview()
  const aux = useMemo(() => {
    const lines: Vec2[] = []
    for (const e of model.entities) {
      if (e.type === 'spline') {
        if (e.mode === 'ctrl') lines.push(...toPairs(e.pts.map((p) => pos(model, p)), !!e.closed))
        else if (e.mode === 'bez') for (let i = 0; i + 1 < e.pts.length; i++) { if (i % 3 !== 2) lines.push(pos(model, e.pts[i]), pos(model, e.pts[i + 1])) }
        else {
          if (e.t0) lines.push(pos(model, e.pts[0]), pos(model, e.t0))
          if (e.t1) lines.push(pos(model, e.pts[e.pts.length - 1]), pos(model, e.t1))
        }
      } else if (e.type === 'ellipse') lines.push(pos(model, e.c), pos(model, e.m))
    }
    return lines
  }, [model])
  const handles = useMemo(() => model.entities.flatMap((e) => (e.type === 'spline' ? [e.t0, e.t1].filter((x): x is string => !!x).map((id) => pos(model, id)) : [])), [model])
  return (
    <>
      {aux.length > 0 && <Segments pairs={aux} color={colors.accent} width={1} dashed wpp={wpp} order={9} />}
      {prev.polys.map((pts, i) => <Segments key={i} pairs={toPairs(pts)} color={colors.accent} width={1.8} dashed wpp={wpp} order={18} />)}
      {handles.length > 0 && null}
    </>
  )
}
