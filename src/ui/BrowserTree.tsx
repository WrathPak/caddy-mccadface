import { useState, type ReactNode } from 'react'
import * as CM from '@radix-ui/react-context-menu'
import { CaretDown, CaretRight, DotOutline, Cube, Eye, EyeSlash, FileText, Folder, GridFour, LineSegment, PencilSimpleLine, Planet, Parallelogram, SelectionBackground } from '@phosphor-icons/react'
import { useUi, type EntityKind } from '@/store/ui'
import { useDoc, type TreeEntity } from '@/doc/store'
import { PLANE_FEATURES } from '@/sketch/planes'
import { ConfigurationsGroup } from '@/features/modeling-tools/ConfigUi'
import { ComponentsSection, JointsSection } from '@/assembly/ComponentTree'
import { ownerOf } from '@/assembly/instances'
import { ROOT } from '@/assembly/types'
import { Tip } from './Tooltip'

/** What a row in the Browser is, for its tooltip. */
const KIND_HELP: Partial<Record<EntityKind, string>> = {
  body: 'A solid or surface shape. Click to select it, double-click to rename it, right-click for more.',
  mesh: 'A body made of triangles, usually from an STL file. Click to select it, double-click to rename it.',
  sketch: 'A 2D drawing. Click to select it, double-click to rename it.',
  plane: 'A flat reference plane that sketches can sit on. Planes start hidden; the eye shows them.',
  axis: 'A reference line to revolve or pattern around.',
  point: 'A reference point other tools can snap to.',
  component: 'A part of an assembly. Click to select it.',
}

interface RowProps {
  id: string
  name: string
  depth: number
  kind?: EntityKind
  icon?: ReactNode
  /** group rows have a caret; leaf rows have an eye */
  open?: boolean
  onToggle?: () => void
  /** doc store collection for rename/delete */
  coll?: 'bodies' | 'surfaces' | 'sketches' | 'meshes'
  eye?: boolean
  /** the component instance the entity is shown under (selections carry it) */
  path?: string
  /** picking this row first makes that instance the active component (the origin planes of a component) */
  activate?: string
}

function Row({ id, name, depth, kind, icon, open, onToggle, coll, eye = true, path, activate }: RowProps) {
  const hidden = useUi((s) => !!s.hiddenIds[id])
  const toggleHidden = useUi((s) => s.toggleHidden)
  const selected = useUi((s) => !!kind && s.selection.some((r) => r.id === id && r.kind === kind && (r.path === undefined || r.path === (path ?? ''))))
  const setSelection = useUi((s) => s.setSelection)
  const rename = useDoc((s) => s.renameEntity)
  const del = useDoc((s) => s.deleteEntity)
  const [editing, setEditing] = useState(false)
  const isolate = () => {
    const d = useDoc.getState()
    useUi.getState().isolate(id, [...d.bodies, ...d.surfaces, ...d.meshes, ...d.sketches].map((e) => e.id))
  }
  const isolated = useUi((s) => {
    const d = useDoc.getState()
    const others = [...d.bodies, ...d.surfaces, ...d.meshes, ...d.sketches].map((e) => e.id).filter((x) => x !== id)
    return !s.hiddenIds[id] && others.length > 0 && others.every((x) => s.hiddenIds[x])
  })
  const isGroup = onToggle !== undefined

  const row = (
    <div
      className={'tree-row' + (isGroup ? ' group' : '')}
      data-selected={selected}
      style={{ paddingLeft: 4 + depth * 12 }}
      onClick={(e) => (isGroup ? onToggle!() : kind && (activate && useDoc.getState().setActiveOcc(activate), setSelection([{ kind, id, path }], e.ctrlKey || e.shiftKey)))}
      onDoubleClick={() => coll && setEditing(true)}
    >
      <span className="caret">{isGroup ? open ? <CaretDown size={9} weight="bold" /> : <CaretRight size={9} weight="bold" /> : null}</span>
      <span style={{ display: 'inline-flex', color: 'var(--text-dim)' }}>{icon}</span>
      {editing ? (
        <input
          className="rename"
          autoFocus
          defaultValue={name}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => { if (coll && e.currentTarget.value.trim()) rename(coll, id, e.currentTarget.value.trim()); setEditing(false) }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(false) }}
        />
      ) : (
        <Tip label={name} desc={isGroup ? 'Click to open or close this group.' : (kind && KIND_HELP[kind]) || undefined} side="right"><span className="name">{name}</span></Tip>
      )}
      {eye && !isGroup && (
        <Tip label={hidden ? 'Show' : 'Hide'} desc={hidden ? 'Bring this back into the view.' : 'Hide this from the view. It stays in the document.'} side="right">
          <button type="button" className="eye" data-off={hidden} aria-label={hidden ? 'Show' : 'Hide'}
            onClick={(e) => { e.stopPropagation(); toggleHidden(id) }}>
            {hidden ? <EyeSlash size={12} /> : <Eye size={12} />}
          </button>
        </Tip>
      )}
    </div>
  )
  if (!coll) return row
  return (
    <CM.Root>
      <CM.Trigger asChild>{row}</CM.Trigger>
      <CM.Portal>
        <CM.Content className="menu">
          <CM.Item className="menu-item" onSelect={() => setEditing(true)}>Rename<span className="kbd">F2</span></CM.Item>
          <CM.Item className="menu-item" onSelect={isolate}>{isolated ? 'Show all' : 'Isolate'}</CM.Item>
          <CM.Item className="menu-item" onSelect={() => toggleHidden(id)}>{hidden ? 'Show' : 'Hide'}</CM.Item>
          <CM.Separator className="menu-sep" />
          <CM.Item className="menu-item" onSelect={() => del(coll, id)}>Delete<span className="kbd">Del</span></CM.Item>
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  )
}

function Group({ label, depth, icon, children, defaultOpen = true }: { label: string; depth: number; icon: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <>
      <Row id={'g:' + label} name={label} depth={depth} icon={icon} open={open} onToggle={() => setOpen(!open)} />
      {open && children}
    </>
  )
}

function Items({ items, depth, kind, coll, icon, path }: { items: TreeEntity[]; depth: number; kind: EntityKind; coll: 'bodies' | 'surfaces' | 'sketches' | 'meshes'; icon: ReactNode; path?: string }) {
  return <>{items.map((e) => <Row key={e.id} id={e.id} name={e.name} depth={depth} kind={kind} coll={coll} icon={icon} path={path} />)}</>
}

/** Document > Origin (planes, axes) > Bodies > Surfaces > Sketches > Meshes > Components (each with its own bodies and sketches) > Joints */
export function BrowserTree() {
  const doc = useDoc()
  const a = doc.assembly
  const owner = new Map(doc.geometry.map((b) => [b.id, ownerOf(b, a)]))
  const inDef = (def: string) => (f: { component?: string }) => (f.component ?? ROOT) === def
  const bodiesOf = (def: string) => doc.bodies.filter((e) => owner.get(e.id) === def)
  const surfacesOf = (def: string) => doc.surfaces.filter((e) => owner.get(e.id) === def)
  const meshesOf = (def: string) => doc.meshes.filter((e) => owner.get(e.id) === def)
  const sketchesOf = (def: string) => doc.sketches.filter((e) => inDef(def)(doc.features.find((f) => f.id === e.id) ?? {}))

  /** What a component holds. The root keeps the familiar groups; the others only show the groups that have something in them. */
  const content = (def: string, path: string, depth: number) => {
    const feats = doc.features.filter(inDef(def))
    const planes = feats.filter((f) => PLANE_FEATURES.has(f.type))
    const axes = feats.filter((f) => f.type === 'constructAxis')
    const points = feats.filter((f) => f.type === 'constructPoint')
    const bodies = bodiesOf(def), surfaces = surfacesOf(def), sketches = sketchesOf(def), meshes = meshesOf(def)
    return (
      <>
        {def !== ROOT && (
          <Group label="Origin" depth={depth} icon={<Planet size={13} />} defaultOpen={false}>
            {['XY', 'XZ', 'YZ'].map((p) => <Row key={p} id={'plane' + p} name={p + ' plane'} depth={depth + 1} kind="plane" icon={<Parallelogram size={13} />} activate={path} />)}
            {['X', 'Y', 'Z'].map((a) => <Row key={a} id={'axis' + a} name={a + ' axis'} depth={depth + 1} kind="axis" icon={<LineSegment size={13} />} activate={path} />)}
          </Group>
        )}
        {(planes.length + axes.length + points.length > 0) && (
          <Group label="Construction" depth={depth} icon={<Folder size={13} />} defaultOpen={false}>
            {planes.map((f) => <Row key={f.id} id={f.id} name={f.name} depth={depth + 1} kind="plane" coll="sketches" icon={<Parallelogram size={13} />} />)}
            {axes.map((f) => <Row key={f.id} id={f.id} name={f.name} depth={depth + 1} kind="axis" coll="sketches" icon={<LineSegment size={13} />} />)}
            {points.map((f) => <Row key={f.id} id={f.id} name={f.name} depth={depth + 1} kind="point" coll="sketches" icon={<DotOutline size={13} />} />)}
          </Group>
        )}
        {bodies.length > 0 && <Group label="Bodies" depth={depth} icon={<Folder size={13} />}><Items items={bodies} depth={depth + 1} kind="body" coll="bodies" icon={<Cube size={13} />} path={path} /></Group>}
        {surfaces.length > 0 && <Group label="Surfaces" depth={depth} icon={<Folder size={13} />}><Items items={surfaces} depth={depth + 1} kind="body" coll="surfaces" icon={<SelectionBackground size={13} />} path={path} /></Group>}
        {sketches.length > 0 && <Group label="Sketches" depth={depth} icon={<Folder size={13} />}><Items items={sketches} depth={depth + 1} kind="sketch" coll="sketches" icon={<PencilSimpleLine size={13} />} path={path} /></Group>}
        {meshes.length > 0 && <Group label="Meshes" depth={depth} icon={<Folder size={13} />}><Items items={meshes} depth={depth + 1} kind="mesh" coll="meshes" icon={<GridFour size={13} />} path={path} /></Group>}
      </>
    )
  }

  return (
    <div className="panel" data-tour="browser">

      <div className="panel-scroll" style={{ paddingTop: 2 }}>
        <Group label={`Document: ${doc.name}`} depth={0} icon={<FileText size={13} />}>
          <Group label="Origin" depth={1} icon={<Planet size={13} />}>
            <Group label="Planes" depth={2} icon={<Folder size={13} />} defaultOpen={false}>
              {['XY', 'XZ', 'YZ'].map((p) => <Row key={p} id={'plane' + p} name={p + ' plane'} depth={3} kind="plane" icon={<Parallelogram size={13} />} />)}
              {doc.features.filter((f) => PLANE_FEATURES.has(f.type) && inDef(ROOT)(f)).map((f) => <Row key={f.id} id={f.id} name={f.name} depth={3} kind="plane" coll="sketches" icon={<Parallelogram size={13} />} />)}
            </Group>
            <Group label="Axes" depth={2} icon={<Folder size={13} />} defaultOpen={false}>
              {['X', 'Y', 'Z'].map((a) => <Row key={a} id={'axis' + a} name={a + ' axis'} depth={3} kind="axis" icon={<LineSegment size={13} />} />)}
              {doc.features.filter((f) => f.type === 'constructAxis' && inDef(ROOT)(f)).map((f) => <Row key={f.id} id={f.id} name={f.name} depth={3} kind="axis" coll="sketches" icon={<LineSegment size={13} />} />)}
            </Group>
          </Group>
          <Group label="Points" depth={1} icon={<Folder size={13} />} defaultOpen={false}>
            {doc.features.filter((f) => f.type === 'constructPoint' && inDef(ROOT)(f)).map((f) => <Row key={f.id} id={f.id} name={f.name} depth={2} kind="point" coll="sketches" icon={<DotOutline size={13} />} />)}
          </Group>
          <ConfigurationsGroup depth={1} />
          <Group label="Bodies" depth={1} icon={<Folder size={13} />}>
            <Items items={bodiesOf(ROOT)} depth={2} kind="body" coll="bodies" icon={<Cube size={13} />} />
          </Group>
          <Group label="Surfaces" depth={1} icon={<Folder size={13} />}>
            <Items items={surfacesOf(ROOT)} depth={2} kind="body" coll="surfaces" icon={<SelectionBackground size={13} />} />
          </Group>
          <Group label="Sketches" depth={1} icon={<Folder size={13} />}>
            <Items items={sketchesOf(ROOT)} depth={2} kind="sketch" coll="sketches" icon={<PencilSimpleLine size={13} />} />
          </Group>
          <Group label="Meshes" depth={1} icon={<Folder size={13} />}>
            <Items items={meshesOf(ROOT)} depth={2} kind="mesh" coll="meshes" icon={<GridFour size={13} />} />
          </Group>
          <ComponentsSection depth={1} content={content} />
          <JointsSection depth={1} />
        </Group>
      </div>
    </div>
  )
}
