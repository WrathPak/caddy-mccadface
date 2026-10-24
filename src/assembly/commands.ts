/** Assemble tab: commands and ribbon layout. Imported once from app/docCommands.ts. */
import {
  ArrowsInSimple, ArrowsOutSimple, ClipboardText, Copy, Cube, FilmStrip, GearSix, Hand, HandGrabbing, Intersect, LinkSimple, Package, PlugsConnected, PushPin, Ruler, Stack, Wrench,
} from '@phosphor-icons/react'
import { registerCommand } from '@/app/commands'
import { RIBBON_TABS } from '@/app/ribbon'
import { useDoc } from '@/doc/store'
import { pickFiles, pickProject } from '@/io/files'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import { useSketch } from '@/sketch/store'
import { activateOcc, componentsFromBodies, newComponent, occLabel, setGrounded } from './actions'
import { copyComponent, pasteComponent } from './clipboard'
import { runInterference } from './check'
import { insertExternal } from './external'
import { startAsBuilt, startJoint, startMotionLink } from './jointDialog'
import { animateExplode } from './motion'
import { useAssemblyRuntime, type AssemblyPanel } from './runtime'
import { selectedInstances } from './selection'

/** Assemble tools are unavailable while a sketch is open (finish it first). */
const outsideSketch = (fn: () => void) => () => { if (!useSketch.getState().active) fn() }

const panel = (id: AssemblyPanel) => () => {
  const rt = useAssemblyRuntime.getState()
  rt.setPanel(rt.panel === id ? null : id)
}

/** Bodies the selection points at (a body, or a face or an edge of it). */
export function selectedBodyIds(): string[] {
  const geometry = useDoc.getState().geometry
  const ids = [...new Set(useUi.getState().selection.filter((r) => ['body', 'mesh', 'face', 'edge'].includes(r.kind)).map((r) => r.id))]
  return ids.filter((id) => geometry.some((b) => b.id === id))
}

async function insert(linked: boolean) {
  try {
    if (linked) {
      const f = await pickProject()
      if (!f) return
      const r = await insertExternal(f.bytes, f.name, { linked: true, stamp: f.stamp, handle: f.handle })
      toast(f.handle ? `Inserted ${f.name} as a linked component. It is checked against the file whenever you come back to this window.` : `Inserted ${f.name} as a linked component. This browser cannot watch the file, so use Update from file to take a newer version.`)
      activateOcc(null)
      useUi.getState().setSelection([{ kind: 'component', id: r.path }])
    } else {
      const [f] = await pickFiles('.caddy')
      if (!f) return
      const r = await insertExternal(new Uint8Array(await f.arrayBuffer()), f.name, { linked: false, stamp: f.lastModified })
      toast(`Inserted a copy of ${f.name} into this document.`)
      activateOcc(null)
      useUi.getState().setSelection([{ kind: 'component', id: r.path }])
    }
  } catch (e) {
    toast(`Insert failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}

registerCommand({
  id: 'assembly.newComponent', label: 'New Component', icon: Package, category: 'Assemble',
  tip: 'Add an empty component inside the active one and make it active: the features you add next go into it',
  run: outsideSketch(() => { const r = newComponent(); toast(`${occLabel(useDoc.getState().assembly, r.path)} is the active component. New features go into it.`) }),
})
registerCommand({
  id: 'assembly.fromBodies', label: 'Components from Bodies', icon: Stack, category: 'Assemble',
  tip: 'Turn each selected body into a component of its own (with the feature that made it)',
  run: outsideSketch(() => {
    const ids = selectedBodyIds()
    if (!ids.length) return void toast('Select the bodies to turn into components, in the viewport or the Browser.', 'error')
    const made = componentsFromBodies(ids)
    toast(`Made ${made.length} ${made.length === 1 ? 'component' : 'components'}.`)
    useUi.getState().clearSelection()
  }),
})
registerCommand({
  id: 'assembly.activateRoot', label: 'Activate Root', icon: Cube, category: 'Assemble',
  tip: 'Leave the component you are editing: new features go into the root component and everything shows normally',
  run: () => activateOcc(null),
})
registerCommand({
  id: 'assembly.activate', label: 'Activate Selected', icon: Cube, category: 'Assemble', hidden: true,
  run: () => { const s = selectedInstances(); if (s.length) activateOcc(s[0]) },
})
registerCommand({ id: 'assembly.insertLinked', label: 'Insert Linked', icon: LinkSimple, category: 'Assemble', tip: 'Insert another .caddy file as a component that follows the file: you are told when it changes', run: outsideSketch(() => void insert(true)) })
registerCommand({ id: 'assembly.insertEmbedded', label: 'Insert Embedded Copy', icon: Package, category: 'Assemble', tip: 'Insert another .caddy file as a component, as a copy stored in this document', run: outsideSketch(() => void insert(false)) })
registerCommand({
  id: 'assembly.copy', label: 'Copy Component', icon: Copy, category: 'Assemble', shortcut: 'Ctrl+C',
  tip: 'Copy the selected component, to paste it as another instance',
  run: () => { const s = selectedInstances(); if (s.length) copyComponent(s[s.length - 1]) },
})
registerCommand({
  id: 'assembly.paste', label: 'Paste as Instance', icon: ClipboardText, category: 'Assemble', shortcut: 'Ctrl+V',
  tip: 'Add another instance of the copied component. Instances share the same geometry',
  run: outsideSketch(() => void pasteComponent()),
})
registerCommand({
  id: 'assembly.ground', label: 'Ground', icon: PushPin, category: 'Assemble',
  tip: 'Fix the selected components in place: joints move the others around them',
  run: outsideSketch(() => {
    const sel = selectedInstances()
    if (!sel.length) return void toast('Select the components to ground.', 'error')
    const a = useDoc.getState().assembly
    const all = sel.every((p) => a.occurrences.find((o) => o.id === p.slice(p.lastIndexOf('/') + 1))?.grounded)
    for (const p of sel) setGrounded(p, !all)
    toast(all ? 'Ungrounded.' : `Grounded ${sel.length} ${sel.length === 1 ? 'component' : 'components'}.`)
  }),
})
registerCommand({ id: 'assembly.joint', label: 'Joint', icon: PlugsConnected, category: 'Assemble', shortcut: 'J', tip: 'Join two components at joint origins snapped to faces, edges, circles or vertices', run: outsideSketch(() => startJoint()) })
registerCommand({ id: 'assembly.asBuilt', label: 'As-built Joint', icon: Wrench, category: 'Assemble', tip: 'Join two components where they are now, without moving them', run: outsideSketch(startAsBuilt) })
registerCommand({ id: 'assembly.motionLink', label: 'Motion Link', icon: GearSix, category: 'Assemble', tip: 'Make one joint follow another by a ratio: gears, rack and pinion, screws', run: outsideSketch(startMotionLink) })
registerCommand({ id: 'assembly.drive', label: 'Drive Joints', icon: Hand, category: 'Assemble', tip: 'Move joints with sliders and see the assembly follow', run: panel('joints') })
registerCommand({
  id: 'assembly.drag', label: 'Move Component', icon: HandGrabbing, category: 'Assemble',
  tip: 'Drag a component in the viewport: it moves the way its joint lets it',
  run: () => {
    const rt = useAssemblyRuntime.getState()
    const on = rt.tool !== 'drag'
    rt.setTool(on ? 'drag' : null)
    useUi.getState().setActiveTool(on ? 'assembly.drag' : null)
  },
})
registerCommand({ id: 'assembly.motion', label: 'Motion Study', icon: FilmStrip, category: 'Assemble', tip: 'Animate joint values with keyframes and play them', run: panel('motion') })
registerCommand({
  id: 'assembly.interference', label: 'Interference', icon: Intersect, category: 'Assemble',
  tip: 'Find parts that overlap and show the overlap in red',
  run: () => {
    useAssemblyRuntime.getState().setPanel('check')
    void runInterference(selectedInstances()).catch((e) => toast(e instanceof Error ? e.message : String(e), 'error'))
  },
})
registerCommand({ id: 'assembly.clearance', label: 'Clearance', icon: Ruler, category: 'Assemble', tip: 'Measure the smallest gap between two selected components', run: panel('check') })
registerCommand({ id: 'assembly.explode', label: 'Explode Steps', icon: ArrowsOutSimple, category: 'Assemble', tip: 'Build an exploded view as a series of steps that move components along a direction', run: panel('explode') })
registerCommand({
  id: 'assembly.explodeToggle', label: 'Explode / Collapse', icon: ArrowsInSimple, category: 'Assemble',
  tip: 'Play the exploded view out, or put everything back',
  run: () => {
    if (!useDoc.getState().assembly.explode.steps.length) { useAssemblyRuntime.getState().setPanel('explode'); return void toast('Add explode steps first: select components and add a step.', 'error') }
    animateExplode(useAssemblyRuntime.getState().explode > 0.5 ? 0 : 1)
  },
})

const at = RIBBON_TABS.findIndex((t) => t.id === 'surface')
RIBBON_TABS.splice(at < 0 ? 1 : at, 0, {
  id: 'assemble',
  label: 'Assemble',
  groups: [
    {
      label: 'Component',
      items: [{ cmd: 'assembly.newComponent' }, { cmd: 'assembly.fromBodies' }, { cmd: 'assembly.insertLinked', menu: ['assembly.insertLinked', 'assembly.insertEmbedded'] }, { stack: ['assembly.activateRoot', 'assembly.copy', 'assembly.paste'] }],
    },
    { label: 'Joint', items: [{ cmd: 'assembly.joint' }, { cmd: 'assembly.asBuilt' }, { cmd: 'assembly.ground' }, { cmd: 'assembly.motionLink' }] },
    { label: 'Motion', items: [{ cmd: 'assembly.drive' }, { cmd: 'assembly.drag' }, { cmd: 'assembly.motion' }] },
    { label: 'Inspect', items: [{ cmd: 'assembly.interference' }, { cmd: 'assembly.clearance' }] },
    { label: 'Present', items: [{ cmd: 'assembly.explode' }, { cmd: 'assembly.explodeToggle' }] },
  ],
})

