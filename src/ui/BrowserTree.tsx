import { useState, type ReactNode } from 'react'
import * as CM from '@radix-ui/react-context-menu'
import { CaretDown, CaretRight, DotOutline, Cube, Eye, EyeSlash, FileText, Folder, GridFour, LineSegment, PencilSimpleLine, Planet, Parallelogram } from '@phosphor-icons/react'
import { useUi, type EntityKind } from '@/store/ui'
import { useDoc, type TreeEntity } from '@/doc/store'
import { PLANE_FEATURES } from '@/sketch/planes'
import { ConfigurationsGroup } from '@/features/modeling-tools/ConfigUi'

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
  coll?: 'bodies' | 'sketches' | 'meshes'
  eye?: boolean
}

function Row({ id, name, depth, kind, icon, open, onToggle, coll, eye = true }: RowProps) {
  const hidden = useUi((s) => !!s.hiddenIds[id])
  const toggleHidden = useUi((s) => s.toggleHidden)
  const selected = useUi((s) => !!kind && s.selection.some((r) => r.id === id && r.kind === kind))
  const setSelection = useUi((s) => s.setSelection)
  const rename = useDoc((s) => s.renameEntity)
  const del = useDoc((s) => s.deleteEntity)
  const [editing, setEditing] = useState(false)
  const isolate = () => {
    const d = useDoc.getState()
    useUi.getState().isolate(id, [...d.bodies, ...d.meshes, ...d.sketches].map((e) => e.id))
  }
  const isolated = useUi((s) => {
    const d = useDoc.getState()
    const others = [...d.bodies, ...d.meshes, ...d.sketches].map((e) => e.id).filter((x) => x !== id)
    return !s.hiddenIds[id] && others.length > 0 && others.every((x) => s.hiddenIds[x])
  })
  const isGroup = onToggle !== undefined

  const row = (
    <div
      className={'tree-row' + (isGroup ? ' group' : '')}
      data-selected={selected}
      style={{ paddingLeft: 4 + depth * 12 }}
      onClick={(e) => (isGroup ? onToggle!() : kind && setSelection([{ kind, id }], e.ctrlKey || e.shiftKey))}
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
        <span className="name">{name}</span>
      )}
      {eye && !isGroup && (
        <button type="button" className="eye" data-off={hidden} title={hidden ? 'Show' : 'Hide'}
          onClick={(e) => { e.stopPropagation(); toggleHidden(id) }}>
          {hidden ? <EyeSlash size={12} /> : <Eye size={12} />}
        </button>
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

function Items({ items, depth, kind, coll, icon }: { items: TreeEntity[]; depth: number; kind: EntityKind; coll: 'bodies' | 'sketches' | 'meshes'; icon: ReactNode }) {
  return <>{items.map((e) => <Row key={e.id} id={e.id} name={e.name} depth={depth} kind={kind} coll={coll} icon={icon} />)}</>
}

/** Document > Origin (planes, axes) > Bodies > Sketches > Meshes */
export function BrowserTree() {
  const doc = useDoc()
  return (
    <div className="panel">
      
      <div className="panel-scroll" style={{ paddingTop: 2 }}>
        <Group label={`Document: ${doc.name}`} depth={0} icon={<FileText size={13} />}>
          <Group label="Origin" depth={1} icon={<Planet size={13} />}>
            <Group label="Planes" depth={2} icon={<Folder size={13} />} defaultOpen={false}>
              {['XY', 'XZ', 'YZ'].map((p) => <Row key={p} id={'plane' + p} name={p + ' plane'} depth={3} kind="plane" icon={<Parallelogram size={13} />} />)}
              {doc.features.filter((f) => PLANE_FEATURES.has(f.type)).map((f) => <Row key={f.id} id={f.id} name={f.name} depth={3} kind="plane" coll="sketches" icon={<Parallelogram size={13} />} />)}
            </Group>
            <Group label="Axes" depth={2} icon={<Folder size={13} />} defaultOpen={false}>
              {['X', 'Y', 'Z'].map((a) => <Row key={a} id={'axis' + a} name={a + ' axis'} depth={3} kind="axis" icon={<LineSegment size={13} />} />)}
              {doc.features.filter((f) => f.type === 'constructAxis').map((f) => <Row key={f.id} id={f.id} name={f.name} depth={3} kind="axis" coll="sketches" icon={<LineSegment size={13} />} />)}
            </Group>
          </Group>
          <Group label="Points" depth={1} icon={<Folder size={13} />} defaultOpen={false}>
            {doc.features.filter((f) => f.type === 'constructPoint').map((f) => <Row key={f.id} id={f.id} name={f.name} depth={2} kind="point" coll="sketches" icon={<DotOutline size={13} />} />)}
          </Group>
          <ConfigurationsGroup depth={1} />
          <Group label="Bodies" depth={1} icon={<Folder size={13} />}>
            <Items items={doc.bodies} depth={2} kind="body" coll="bodies" icon={<Cube size={13} />} />
          </Group>
          <Group label="Sketches" depth={1} icon={<Folder size={13} />}>
            <Items items={doc.sketches} depth={2} kind="sketch" coll="sketches" icon={<PencilSimpleLine size={13} />} />
          </Group>
          <Group label="Meshes" depth={1} icon={<Folder size={13} />}>
            <Items items={doc.meshes} depth={2} kind="mesh" coll="meshes" icon={<GridFour size={13} />} />
          </Group>
        </Group>
      </div>
    </div>
  )
}
