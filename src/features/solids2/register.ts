/**
 * Registers the second wave of solid tools: commands, ribbon entries (Create, Modify, Inspect of the Solid tab) and the features
 * themselves. Everything is added from here, so the shared command and ribbon files stay as they are.
 */
import {
  ArrowsHorizontal, ArrowsInLineHorizontal, ArrowsOutLineVertical, Circle, CircleNotch, Cube, Pipe, Spiral, Wall,
} from '@phosphor-icons/react'
import type { Icon } from '@phosphor-icons/react'
import { registerCommand } from '@/app/commands'
import { RIBBON_TABS } from '@/app/ribbon'
import { useSketch } from '@/sketch/store'
import './prims'
import './rib'
import './transform'
import './material'
import { startCoil, startPipe, startSphere, startTorus } from './prims'
import { startRib, startWeb } from './rib'
import { startAlign, startScale } from './transform'
import { startMaterial } from './material'

/** Solid tools are unavailable while a sketch is open (finish it first). */
const solid = (fn: () => void) => () => { if (!useSketch.getState().active) fn() }
function cmd(id: string, label: string, icon: Icon, category: string, run: () => void, tip: string) {
  registerCommand({ id, label, icon, category, run: solid(run), tip })
}

cmd('solid.rib', 'Rib', ArrowsOutLineVertical, 'Create', startRib, 'A sketched line thickened into a wall that grows from the line up to the faces it meets')
cmd('solid.web', 'Web', Wall, 'Create', startWeb, 'Thin walls built on the lines of a sketch, up to the faces they meet')
cmd('solid.sphere', 'Sphere', Circle, 'Create', startSphere, 'A ball with a centre point and a radius')
cmd('solid.torus', 'Torus', CircleNotch, 'Create', startTorus, 'A ring with a ring radius and a tube radius')
cmd('solid.coil', 'Coil', Spiral, 'Create', startCoil, 'A spring or thread-like helix from revolutions, height and pitch, with a round, square or triangular wire')
cmd('solid.pipe', 'Pipe', Pipe, 'Create', startPipe, 'A pipe that follows a sketched path, with a round, square or triangular section and an optional bore')
cmd('solid.align', 'Align', ArrowsHorizontal, 'Modify', startAlign, 'Move a body so a face, edge or corner of it lands on a face, edge or corner of another body')
cmd('solid.scale', 'Scale', ArrowsInLineHorizontal, 'Modify', startScale, 'Make bodies bigger or smaller about a point, evenly or with a different factor along X, Y and Z')
cmd('solid.material', 'Physical Material', Cube, 'Modify', startMaterial, 'Give bodies a material with a density, so Measure can tell their mass and centre of gravity')

function group(tab: string, label: string) {
  const t = RIBBON_TABS.find((x) => x.id === tab)!
  return t.groups.find((g) => g.label === label)!
}
{
  const create = group('solid', 'Create')
  const box = create.items.find((i) => i.cmd === 'solid.box')
  if (box) box.menu = ['solid.box', 'solid.cylinder', 'solid.sphere', 'solid.torus', 'solid.coil', 'solid.pipe']
  const hole = create.items.find((i) => i.cmd === 'solid.hole')
  if (hole) hole.menu = ['solid.hole', 'detail.thread']
  create.items.push({ cmd: 'solid.rib', menu: ['solid.rib', 'solid.web'] })
  const modify = group('solid', 'Modify')
  const move = modify.items.find((i) => i.cmd === 'solid.move')
  if (move) move.menu = ['solid.move', 'solid.align', 'solid.scale']
  modify.items.push({ cmd: 'solid.material', menu: ['solid.material', 'render.assign'] })
  group('solid', 'Inspect').items.push({ cmd: 'assembly.interference' })
}
