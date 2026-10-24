/**
 * DETAIL workspace: text and logos, surface textures, fur / scales / spikes / grass, and threads.
 * Importing this module registers the features, their commands and the ribbon tab.
 */
import { Cactus, Fish, GridNine, ImageSquare, Nut, PawPrint, Plant, TextAa } from '@phosphor-icons/react'
import { registerCommand } from '@/app/commands'
import { RIBBON_TABS } from '@/app/ribbon'
import { useSketch } from '@/sketch/store'
import './detail.css'
import { startEmboss } from './emboss'
import { startGenerator } from './generators'
import { startTexture } from './texture'
import { startThread } from './thread'

/** Like the other solid tools: not while a sketch is open. */
const solid = (fn: () => void) => () => { if (!useSketch.getState().active) fn() }

registerCommand({ id: 'detail.text', label: 'Text', tip: 'Emboss or engrave text on a face, including curved faces', icon: TextAa, category: 'Detail', run: solid(() => startEmboss('text')) })
registerCommand({ id: 'detail.logo', label: 'Logo', tip: 'Emboss or engrave an SVG logo or a picture on a face', icon: ImageSquare, category: 'Detail', run: solid(() => startEmboss('logo')) })
registerCommand({ id: 'detail.texture', label: 'Texture', tip: 'Cover faces with a knurl, leather, hexagon, wood, carbon or picture texture', icon: GridNine, category: 'Detail', run: solid(startTexture) })
registerCommand({ id: 'detail.fur', label: 'Fur', tip: 'Short, dense, tapered fur with clumping, for any face', icon: PawPrint, category: 'Detail', run: solid(() => startGenerator('fur')) })
registerCommand({ id: 'detail.scales', label: 'Scales', tip: 'Overlapping scales that follow a flow direction', icon: Fish, category: 'Detail', run: solid(() => startGenerator('scales')) })
registerCommand({ id: 'detail.spikes', label: 'Spikes', tip: 'Cones and pyramids of varying size', icon: Cactus, category: 'Detail', run: solid(() => startGenerator('spikes')) })
registerCommand({ id: 'detail.grass', label: 'Grass', tip: 'Curved, tapered blades of grass', icon: Plant, category: 'Detail', run: solid(() => startGenerator('grass')) })
registerCommand({ id: 'detail.thread', label: 'Thread', tip: 'Model an ISO metric or custom thread on a round face, with a printing clearance', icon: Nut, category: 'Detail', run: solid(startThread) })

if (!RIBBON_TABS.some((t) => t.id === 'detail')) {
  const at = RIBBON_TABS.findIndex((t) => t.id === 'hair')
  RIBBON_TABS.splice(at >= 0 ? at + 1 : RIBBON_TABS.length, 0, {
    id: 'detail',
    label: 'Detail',
    groups: [
      { label: 'Text and logos', items: [{ cmd: 'detail.text' }, { cmd: 'detail.logo' }] },
      { label: 'Surface', items: [{ cmd: 'detail.texture' }] },
      { label: 'Generate', items: [{ cmd: 'detail.fur' }, { cmd: 'detail.scales' }, { cmd: 'detail.spikes' }, { cmd: 'detail.grass' }] },
      { label: 'Threads', items: [{ cmd: 'detail.thread' }] },
    ],
  })
}
