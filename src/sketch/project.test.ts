/** Associative Project: projected geometry follows its source on regeneration; a lost source flags the curves and warns. */
import { beforeAll, describe, expect, it } from 'vitest'
import { box, initOcc, topoOf } from '../kernel/occ'
import { bodyFromShape, getBrep, getOp, helpers } from '../kernel/store'
import type { ProjectedCurve } from '../kernel/sketch-ops'
import type { Body } from '../kernel/types'
import '../kernel/sketch-ops'
import { encodeRef, refFromSelection } from '../doc/refs'
import { getFeature } from '../doc/registry'
import '../features/sketch'
import { ensureSolver } from './solver'
import { addCoincident, addLine, addPoint, entityById, pos } from './model'
import { addProjected, brokenCount, reprojectModel, type KernelCall } from './project'
import { emptyModel, type LineE, type PlaneDef, type SketchModel } from './types'
import type { AnyShape } from 'replicad'

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }
const call: KernelCall = async (name, args) => getOp(name)!(args as never, helpers)

const boxBody = (w: number): Body => ({ ...bodyFromShape('b1', 'Box', box([w, 10, 5], [0, 0, 0])), featureId: 'f1' })
const topFace = (b: Body) => topoOf(getBrep(b.key) as unknown as AnyShape).faces.findIndex((f) => f.geomType === 'PLANE' && Math.abs(f.center.z - 5) < 1e-6)

const refLines = (m: SketchModel) => m.entities.filter((e): e is LineE => e.type === 'line' && !!e.ref)
const xRange = (m: SketchModel) => {
  const xs = refLines(m).flatMap((l) => [pos(m, l.p1)[0], pos(m, l.p2)[0]])
  return [Math.min(...xs), Math.max(...xs)]
}

beforeAll(async () => {
  await initOcc()
  await ensureSolver()
})

describe('associative project', () => {
  async function projected() {
    const b = boxBody(20)
    const ref = encodeRef(refFromSelection({ kind: 'face', id: 'b1', index: topFace(b) }, [b])!)
    const m = emptyModel()
    const curves = (await call('projectEdges', { key: b.key, plane: XY, faces: [topFace(b)], edges: [], all: false })) as ProjectedCurve[]
    expect(addProjected(m, curves, ref)).toBe(4)
    return { m, ref, b }
  }

  it('stores the source ref with the projected curves', async () => {
    const { m, ref } = await projected()
    expect(m.projections).toHaveLength(1)
    expect(m.projections![0].ref).toBe(ref)
    expect(m.projections![0].ents).toHaveLength(4)
    expect(xRange(m)).toEqual([-10, 10])
    // projecting the same source again refreshes it instead of duplicating the curves
    expect(addProjected(m, [], ref)).toBe(0)
  })

  it('re-projects when the upstream geometry changes, keeping entity ids and constraints', async () => {
    const { m } = await projected()
    const ids = refLines(m).map((l) => l.id)
    const corner = refLines(m)[0].p1
    const mine = addPoint(m, 0, 0)
    addCoincident(m, mine, corner)
    const nConstraints = m.constraints.length
    const r = await reprojectModel(m, XY, [boxBody(30)], call)
    expect(r).toEqual({ total: 1, broken: 0 })
    expect(xRange(m)).toEqual([-15, 15])
    expect(refLines(m).map((l) => l.id)).toEqual(ids)
    expect(m.constraints).toHaveLength(nConstraints)
    expect(brokenCount(m)).toBe(0)
  })

  it('marks a projection broken (and keeps its last geometry) when the source disappears; re-resolving heals it', async () => {
    const { m } = await projected()
    const r = await reprojectModel(m, XY, [], call)
    expect(r).toEqual({ total: 1, broken: 1 })
    expect(brokenCount(m)).toBe(1)
    expect(refLines(m)).toHaveLength(4)
    for (const l of refLines(m)) {
      expect(l.broken).toBe(true)
      expect(entityById(m, l.p1)!.broken).toBe(true)
    }
    expect(xRange(m)).toEqual([-10, 10])
    const ok = await reprojectModel(m, XY, [boxBody(20)], call)
    expect(ok.broken).toBe(0)
    expect(refLines(m).some((l) => l.broken)).toBe(false)
  })

  it('a changed shape of the projection replaces its curves; deleted curves stay deleted while the shape holds', async () => {
    const { m } = await projected()
    const victim = refLines(m)[0].id
    m.entities = m.entities.filter((e) => e.id !== victim)
    await reprojectModel(m, XY, [boxBody(30)], call)
    expect(m.projections![0].ents.filter(Boolean)).toHaveLength(3)
    expect(entityById(m, victim)).toBeUndefined()
  })

  it('the Sketch feature re-projects on compute and reports a warning (not an error) when a ref breaks', async () => {
    const { m } = await projected()
    const def = getFeature('sketch')!
    const run = (bodies: Body[]) =>
      def.compute({ feature: { id: 's1', type: 'sketch', name: 'Sketch' }, bodies, kernel: { call } } as never, { sketch: JSON.stringify({ plane: XY, face: null, model: m }) })

    const grown = await run([boxBody(40)])
    expect(grown.warning).toBeUndefined()
    const data = grown.data as { entities: { type: string; x?: number; ref?: boolean }[] }
    const xs = data.entities.filter((e) => e.type === 'point' && e.ref).map((e) => e.x as number)
    expect(Math.min(...xs)).toBeCloseTo(-20)
    expect(Math.max(...xs)).toBeCloseTo(20)

    const lost = await run([])
    expect(lost.warning).toMatch(/lost the source geometry/)
    const lostData = lost.data as { entities: { type: string; broken?: boolean; ref?: boolean }[] }
    expect(lostData.entities.filter((e) => e.type === 'line' && e.ref).every((e) => e.broken)).toBe(true)
  })
})
