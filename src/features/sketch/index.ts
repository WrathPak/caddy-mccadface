/** Sketch feature: stores the constraint model; compute() re-solves it (dimension expressions may use user parameters)
 *  and publishes plane + entities + profiles through ctx.dataOf(). */
import { PencilSimpleLine } from '@phosphor-icons/react'
import { registerFeature } from '@/doc/registry'
import { decodeRef, faceSigs, resolveFace } from '@/doc/refs'
import { useDoc } from '@/doc/store'
import { refreshDims } from '@/sketch/dims'
import { useSketchData } from '@/sketch/draw'
import { planeFromNormal, reanchor } from '@/sketch/plane'
import { detectProfiles } from '@/sketch/profiles'
import { ensureSolver, solveModel } from '@/sketch/solver'
import { beginSketch } from '@/sketch/store'
import type { PlaneDef, SketchData, SketchModel } from '@/sketch/types'

interface Stored { plane: PlaneDef; face: string | null; model: SketchModel }
const parse = (s: unknown): Stored => JSON.parse(String(s)) as Stored

registerFeature({
  type: 'sketch',
  label: 'Sketch',
  icon: PencilSimpleLine,
  schema: { id: 'sketch', title: 'Sketch', params: [] },
  dependsOnParams: true,
  async compute(ctx, p) {
    const st = parse(p.sketch)
    await ensureSolver()
    let plane = st.plane
    if (st.face) {
      const ref = decodeRef(st.face)
      if (ref && ref.kind === 'face') {
        const r = resolveFace(ref, ctx.bodies)
        if (!r) throw new Error('The face this sketch was drawn on no longer exists')
        const sig = faceSigs(r.body)[r.index]
        plane = reanchor(plane, planeFromNormal(sig.centroid, sig.normal))
      }
    }
    const model = JSON.parse(JSON.stringify(st.model)) as SketchModel
    const bad = refreshDims(model)
    if (bad.length) throw new Error('Invalid dimension expression')
    const solved = solveModel(model)
    if (!solved.info.ok) throw new Error('Sketch constraints could not be solved')
    const data: SketchData = {
      plane,
      entities: solved.model.entities,
      constraints: solved.model.constraints,
      profiles: detectProfiles(solved.model),
    }
    useSketchData.getState().set(ctx.feature.id, data)
    return { data }
  },
  edit(id, params) {
    const d = useDoc.getState()
    const idx = d.features.findIndex((f) => f.id === id)
    const prev = d.rollback
    d.setRollback(idx)
    const st = parse(params.sketch)
    const plane = useSketchData.getState().data[id]?.plane ?? st.plane
    void beginSketch({ plane, face: st.face, model: st.model, editing: id, onClose: () => useDoc.getState().setRollback(prev) })
  },
})
