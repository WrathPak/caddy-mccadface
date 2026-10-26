// @ts-check
/// <reference path="../../../src/api/caddy-api.d.ts" />

// Gear generator: adds a Gear feature to the Solid tab. Set the teeth, the module and the thickness and you get an involute
// spur gear, with a bore if you want one. The tooth maths lives in involute.js (a plugin can be several files).

import { circleOutline, gearOutline, gearRadii } from './involute.js'

/** @param {CaddyApi} caddy */
export function activate(caddy) {
  caddy.features.register({
    type: 'gear',
    label: 'Gear',
    icon: 'gear',
    ribbon: { tab: 'solid', group: 'Gears' },
    params: [
      { type: 'number', key: 'teeth', label: 'Teeth', help: 'How many teeth the gear has.', min: 6, max: 150, step: 1, default: 20 },
      { type: 'number', key: 'module', label: 'Module', help: 'The size of a tooth in mm: the pitch diameter is the module times the number of teeth. Two gears mesh when their modules match.', unit: 'mm', min: 0.2, max: 20, step: 0.1, default: 2 },
      { type: 'number', key: 'pressureAngle', label: 'Pressure angle', help: 'How steeply the teeth meet. 20 degrees is the usual choice.', unit: 'deg', min: 12, max: 30, step: 0.5, default: 20 },
      { type: 'number', key: 'thickness', label: 'Thickness', help: 'How thick the gear is, in mm.', unit: 'mm', min: 0.1, step: 0.5, default: 8 },
      { type: 'number', key: 'bore', label: 'Bore diameter', help: 'The hole for a shaft, in mm. 0 leaves the gear solid.', unit: 'mm', min: 0, step: 0.5, default: 6 },
      { type: 'vector3', key: 'position', label: 'Base center', help: 'Where the middle of the gear bottom sits, as X, Y, Z in mm.', unit: 'mm', default: [0, 0, 0] },
    ],
    async compute(ctx, p) {
      const teeth = Math.round(Number(p.teeth))
      const module = Number(p.module)
      const pressureAngle = Number(p.pressureAngle)
      const r = gearRadii({ teeth, module, pressureAngle })
      if (Number(p.bore) / 2 >= r.root - module * 0.5) throw new Error(`The bore is too big for this gear: keep it under ${(2 * (r.root - module * 0.5)).toFixed(1)} mm`)
      const bore = Number(p.bore) > 0 ? [circleOutline(Number(p.bore) / 2)] : []
      const gear = await ctx.kernel.extrude({
        outline: gearOutline({ teeth, module, pressureAngle }),
        holes: bore,
        height: Number(p.thickness),
        origin: /** @type {CaddyVec3} */ (p.position),
      })
      return { bodies: [gear], warning: teeth < 14 ? 'With so few teeth the teeth get thin at the root (undercut).' : undefined }
    },
  })
}
