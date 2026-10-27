import { describe, expect, it } from 'vitest'
import type { ParamDef, ParamSchema } from './schema'

function missing(schema: ParamSchema): string[] {
  const out: string[] = []
  const walk = (defs: ParamDef[]) => {
    for (const d of defs) {
      if (d.type === 'group') walk(d.children)
      else if (!d.help || d.help.trim().length < 12) out.push(`${schema.id}.${d.key}`)
    }
  }
  walk(schema.params)
  return out
}

describe('every setting explains itself', () => {
  it('has a help text on every parameter of every feature dialog', async () => {
    // some feature modules touch `window` at import time (file pickers); a bare global is enough in node
    ;(globalThis as unknown as { window: unknown }).window ??= globalThis
    await Promise.all([import('@/features/basic'), import('@/features/solids'), import('@/features/meshTools'), import('@/features/offsetPlane'), import('@/features/extrude'), import('@/features/fillet'), import('@/features/revolve'), import('@/features/hair'), import('@/features/measure'), import('@/features/section'), import('@/features/move'), import('@/features/modeling-tools/register'), import('@/features/surface/register')])
    const { allFeatures } = await import('@/doc/registry')
    const { exportSchema } = await import('@/io/actions')
    const { measureSchema } = await import('@/features/measure')
    const { sectionSchema } = await import('@/features/section')
    const { moveSchema } = await import('@/features/move')
    const { extrudeSchema } = await import('@/features/extrude')
    const { revolveSchema } = await import('@/features/revolve')
    const { offsetPlaneSchema } = await import('@/features/offsetPlane')
    const { boxSchema } = await import('@/features/basic')
    const { cylinderSchema, sweepSchema, loftSchema, combineSchema, shellSchema } = await import('@/features/solids')
    const { hairSchema } = await import('@/features/hair/schema')
    const schemas = [...allFeatures().map((f) => f.schema), exportSchema, measureSchema, sectionSchema, moveSchema, extrudeSchema, revolveSchema, offsetPlaneSchema, boxSchema, cylinderSchema, sweepSchema, loftSchema, combineSchema, shellSchema, hairSchema]
    expect(schemas.length).toBeGreaterThan(14)
    expect(schemas.flatMap(missing)).toEqual([])
  })
})
