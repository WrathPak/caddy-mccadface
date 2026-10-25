/**
 * Worker-side custom operations. Features (sketch/extrude/fillet/hair...) add their kernel work here:
 *
 *   import { registerOp } from './store'
 *   registerOp<{ key: string; dist: number }>('extrude', async (a, h) => h.sendBody(h.bodyFromShape(...)))
 *
 * and call it from a feature's compute() with `await ctx.kernel.call('extrude', args)`.
 * This module is imported once by worker.ts; import your op modules below.
 */
import './model-ops'
import './hair-ops'
import './solid-ops'
import './mesh-ops'
import './detail-ops'
import './modeling-ops'
import './print-ops'
import './drawing-ops'

export {}
