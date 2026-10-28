/** Browser tree parts for assemblies: component nodes (visibility, isolate, activate, rename), joints and motion links. */
import { useState } from 'react'
import * as CM from '@radix-ui/react-context-menu'
import {
  ArrowsClockwise, CaretDown, CaretRight, Cube, Eye, EyeSlash, Folder, LinkSimple, Package, PencilSimpleLine, PushPin, Warning,
} from '@phosphor-icons/react'
import { DEFAULT_HIDDEN, useUi } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { toast } from '@/ui/Modal'
import { Tip } from '@/ui/Tooltip'
import { activateOcc, deleteJoint, deleteLink, deleteOccurrence, instanceOf, occLabel, renameComponent, resetJointToRest, setGrounded, updateJoint } from './actions'
import { flatten, parentPath, within, type OccNode } from './instances'
import { JOINT_TYPES } from './joints'
import { usePlacement } from './place'
import { useAssemblyRuntime } from './runtime'
import { ROOT } from './types'
import { startJoint } from './jointDialog'
import { applyExternalUpdate, dismissExternalUpdate, refreshExternal } from './external'
import { copyComponent, pasteComponent, useClipboard } from './clipboard'

/** Hide everything except an instance (and what it sits in); do it again to show everything. */
/** What isolating an instance hides: every other instance, and the bodies of the root component (which are not instances). */
function hiddenByIsolating(path: string): string[] {
  const d = useDoc.getState()
  const keep = (n: OccNode) => within(n.id, path) || within(path, n.id)
  return [
    ...flatten(d.assembly).filter((n) => !keep(n)).map((n) => n.id),
    ...d.geometry.filter((b) => (d.assembly.bodyOwner[b.id] ?? b.component ?? ROOT) === ROOT).map((b) => b.id),
  ]
}
export function isolateComponent(path: string) {
  const hide = hiddenByIsolating(path)
  const cur = useUi.getState().hiddenIds
  const isolated = hide.length > 0 && hide.every((k) => cur[k]) && !cur[path]
  useUi.setState({ hiddenIds: isolated ? { ...DEFAULT_HIDDEN } : { ...DEFAULT_HIDDEN, ...Object.fromEntries(hide.map((k) => [k, true as const])) } })
}
export function isIsolated(path: string): boolean {
  const hide = hiddenByIsolating(path)
  const cur = useUi.getState().hiddenIds
  return hide.length > 0 && hide.every((k) => cur[k]) && !cur[path]
}

function ComponentRow({ node, depth, children }: { node: OccNode; depth: number; children?: React.ReactNode }) {
  const assembly = useDoc((s) => s.assembly)
  const active = useDoc((s) => s.activeOcc)
  const place = usePlacement()
  const hidden = useUi((s) => !!s.hiddenIds[node.id])
  const toggleHidden = useUi((s) => s.toggleHidden)
  const selected = useUi((s) => s.selection.some((r) => r.kind === 'component' && r.id === node.id))
  const setSelection = useUi((s) => s.setSelection)
  const extErrors = useAssemblyRuntime((s) => s.extErrors)
  const extChanged = useAssemblyRuntime((s) => s.extChanged)
  const clip = useClipboard((s) => s.path)
  const [open, setOpen] = useState(true)
  const [editing, setEditing] = useState(false)
  const def = assembly.components.find((c) => c.id === node.component)
  const label = occLabel(assembly, node.id)
  const isActive = active === node.id
  const ext = def?.external ? assembly.externals.find((e) => e.id === def.external) : undefined
  const jointError = assembly.joints.some((j) => (within(j.a.occ, node.id) || within(j.b.occ, node.id)) && place.solve.errors[j.id])
  const error = (ext && extErrors[ext.id]) || (jointError ? 'A joint of this component cannot be satisfied' : undefined)
  const changed = ext ? extChanged[ext.id] : undefined
  const hasKids = assembly.occurrences.some((o) => o.parent === node.component)
  const isolated = useUi((s) => (s.hiddenIds, isIsolated(node.id)))

  const row = (
    <div
      className="tree-row comp"
      data-testid={'comp-' + node.id}
      data-selected={selected}
      data-active={isActive}
      data-hidden={hidden}
      style={{ paddingLeft: 4 + depth * 12 }}
      onClick={(e) => setSelection([{ kind: 'component', id: node.id }], e.ctrlKey || e.shiftKey)}
      onDoubleClick={() => activateOcc(isActive ? parentPath(node.id) : node.id)}
    >
      <span className="caret" onClick={(e) => { e.stopPropagation(); setOpen(!open) }}>{hasKids ? open ? <CaretDown size={9} weight="bold" /> : <CaretRight size={9} weight="bold" /> : null}</span>
      <Tip label={isActive ? 'Active component: new features go in here. Click to leave it.' : 'Make this the active component: new features go in here'}>
        <button type="button" className="comp-active" data-on={isActive} aria-label={isActive ? 'Deactivate component' : 'Activate component'} aria-pressed={isActive}
          onClick={(e) => { e.stopPropagation(); activateOcc(isActive ? parentPath(node.id) : node.id) }} />
      </Tip>
      <span style={{ display: 'inline-flex', color: 'var(--text-dim)' }}>{ext ? <LinkSimple size={13} /> : <Package size={13} />}</span>
      {editing ? (
        <input
          className="rename" autoFocus defaultValue={def?.name ?? label} onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => { if (e.currentTarget.value.trim()) renameComponent(node.component, e.currentTarget.value.trim()); setEditing(false) }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(false) }}
        />
      ) : (
        <span className="name">{label}</span>
      )}
      {changed && ext && (
        <Tip label={`${ext.fileName} changed on disk. Click to update this component`}>
          <button type="button" className="comp-badge update" data-testid={'ext-update-' + ext.id} aria-label="Update linked component" onClick={(e) => { e.stopPropagation(); void applyExternalUpdate(ext.id) }}><ArrowsClockwise size={12} /></button>
        </Tip>
      )}
      {error && <Tip label={error}><span className="comp-badge err" data-testid={'comp-error-' + node.id}><Warning size={12} /></span></Tip>}
      {assembly.occurrences.find((o) => o.id === node.occ)?.grounded && <Tip label="Grounded: this component does not move"><span className="comp-badge"><PushPin size={12} /></span></Tip>}
      <Tip label={hidden ? 'Show' : 'Hide'} desc={hidden ? 'Bring this component back into the view.' : 'Hide this component from the view. It stays in the document.'} side="right">
  <button type="button" className="eye" data-off={hidden} aria-label={hidden ? 'Show component' : 'Hide component'} onClick={(e) => { e.stopPropagation(); toggleHidden(node.id) }}>
        {hidden ? <EyeSlash size={12} /> : <Eye size={12} />}
      </button>
      </Tip>
    </div>
  )
  const grounded = !!assembly.occurrences.find((o) => o.id === node.occ)?.grounded
  return (
    <>
      <CM.Root>
        <CM.Trigger asChild>{row}</CM.Trigger>
        <CM.Portal>
          <CM.Content className="menu">
            <CM.Item className="menu-item" onSelect={() => activateOcc(isActive ? parentPath(node.id) : node.id)}>{isActive ? 'Deactivate' : 'Activate'}</CM.Item>
            <CM.Item className="menu-item" onSelect={() => setEditing(true)}>Rename<span className="kbd">F2</span></CM.Item>
            <CM.Item className="menu-item" onSelect={() => isolateComponent(node.id)}>{isolated ? 'Show all' : 'Isolate'}</CM.Item>
            <CM.Item className="menu-item" onSelect={() => toggleHidden(node.id)}>{hidden ? 'Show' : 'Hide'}</CM.Item>
            <CM.Separator className="menu-sep" />
            <CM.Item className="menu-item" onSelect={() => setGrounded(node.id, !grounded)}>{grounded ? 'Unground' : 'Ground'}</CM.Item>
            <CM.Item className="menu-item" onSelect={() => copyComponent(node.id)}>Copy<span className="kbd">Ctrl+C</span></CM.Item>
            <CM.Item className="menu-item" disabled={!clip} onSelect={() => void pasteComponent()}>Paste as instance<span className="kbd">Ctrl+V</span></CM.Item>
            <CM.Item className="menu-item" onSelect={() => { const p = instanceOf(node.id); if (p) toast('Added an instance. It shares this component\'s geometry.') }}>Duplicate as instance</CM.Item>
            {ext?.linked && <CM.Item className="menu-item" onSelect={() => void refreshExternal(ext.id)}>Update from file...</CM.Item>}
            {ext && changed && <CM.Item className="menu-item" onSelect={() => dismissExternalUpdate(ext.id)}>Keep this version</CM.Item>}
            <CM.Separator className="menu-sep" />
            <CM.Item className="menu-item" onSelect={() => deleteOccurrence(node.id)}>Delete<span className="kbd">Del</span></CM.Item>
          </CM.Content>
        </CM.Portal>
      </CM.Root>
      {open && children}
    </>
  )
}

/** One entry of the tree under a component: its bodies, sketches and construction geometry, then the components inside it. */
function ComponentNode({ node, depth, nodes, content }: { node: OccNode; depth: number; nodes: OccNode[]; content: (def: string, path: string, depth: number) => React.ReactNode }) {
  const kids = nodes.filter((n) => n.parent === node.id)
  return (
    <ComponentRow node={node} depth={depth}>
      {content(node.component, node.id, depth + 1)}
      {kids.map((k) => <ComponentNode key={k.id} node={k} depth={depth + 1} nodes={nodes} content={content} />)}
    </ComponentRow>
  )
}

/** The component tree under the document: every top level component with what it holds. */
export function ComponentsSection({ depth, content }: { depth: number; content: (def: string, path: string, depth: number) => React.ReactNode }) {
  const assembly = useDoc((s) => s.assembly)
  const [open, setOpen] = useState(true)
  const nodes = flatten(assembly)
  if (!nodes.length) return null
  const top = nodes.filter((n) => n.parent === null)
  return (
    <>
      <div className="tree-row group" data-testid="components-group" style={{ paddingLeft: 4 + depth * 12 }} onClick={() => setOpen(!open)}>
        <span className="caret">{open ? <CaretDown size={9} weight="bold" /> : <CaretRight size={9} weight="bold" />}</span>
        <span style={{ display: 'inline-flex', color: 'var(--text-dim)' }}><Folder size={13} /></span>
        <span className="name">Components</span>
        <span className="comp-count">{nodes.length}</span>
      </div>
      {open && top.map((n) => <ComponentNode key={n.id} node={n} depth={depth + 1} nodes={nodes} content={content} />)}
    </>
  )
}

/** Joints and motion links. */
export function JointsSection({ depth }: { depth: number }) {
  const joints = useDoc((s) => s.assembly.joints)
  const links = useDoc((s) => s.assembly.links)
  const place = usePlacement()
  const selected = useAssemblyRuntime((s) => s.selectedJoint)
  const [open, setOpen] = useState(true)
  if (!joints.length) return null
  const pad = (d: number) => ({ paddingLeft: 4 + d * 12 })
  return (
    <>
      <div className="tree-row group" data-testid="joints-group" style={pad(depth)} onClick={() => setOpen(!open)}>
        <span className="caret">{open ? <CaretDown size={9} weight="bold" /> : <CaretRight size={9} weight="bold" />}</span>
        <span style={{ display: 'inline-flex', color: 'var(--text-dim)' }}><Folder size={13} /></span>
        <span className="name">Joints</span>
        <span className="comp-count">{joints.length}</span>
      </div>
      {open && joints.map((j) => {
        const err = place.solve.errors[j.id] ?? place.frameErrors[j.id]
        return (
          <CM.Root key={j.id}>
            <CM.Trigger asChild>
              <div
                className="tree-row" data-testid={'joint-' + j.id} data-selected={selected === j.id} style={pad(depth + 1)}
                onClick={() => { useAssemblyRuntime.getState().selectJoint(j.id); useAssemblyRuntime.getState().setPanel('joints') }}
                onDoubleClick={() => startJoint(j.id)}
              >
                <span className="caret" />
                <span style={{ display: 'inline-flex', color: 'var(--text-dim)' }}><Cube size={13} /></span>
                <span className="name" style={j.suppressed ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>{j.name}</span>
                <span className="comp-count">{JOINT_TYPES.find((t) => t.type === j.type)?.label}</span>
                {err && <Tip label={err}><span className="comp-badge err"><Warning size={12} /></span></Tip>}
              </div>
            </CM.Trigger>
            <CM.Portal>
              <CM.Content className="menu">
                <CM.Item className="menu-item" onSelect={() => startJoint(j.id)}>Edit</CM.Item>
                <CM.Item className="menu-item" onSelect={() => resetJointToRest(j.id)}>Reset to rest</CM.Item>
                <CM.Item className="menu-item" onSelect={() => updateJoint(j.id, { suppressed: !j.suppressed })}>{j.suppressed ? 'Unsuppress' : 'Suppress'}</CM.Item>
                <CM.Separator className="menu-sep" />
                <CM.Item className="menu-item" onSelect={() => deleteJoint(j.id)}>Delete</CM.Item>
              </CM.Content>
            </CM.Portal>
          </CM.Root>
        )
      })}
      {open && links.map((l) => (
        <CM.Root key={l.id}>
          <CM.Trigger asChild>
            <div className="tree-row" data-testid={'link-' + l.id} style={pad(depth + 1)}>
              <span className="caret" />
              <span style={{ display: 'inline-flex', color: 'var(--text-dim)' }}><PencilSimpleLine size={13} /></span>
              <span className="name">{l.name}</span>
              <span className="comp-count">{`x${+l.ratio.toFixed(4)}`}</span>
            </div>
          </CM.Trigger>
          <CM.Portal>
            <CM.Content className="menu">
              <CM.Item className="menu-item" onSelect={() => deleteLink(l.id)}>Delete motion link</CM.Item>
            </CM.Content>
          </CM.Portal>
        </CM.Root>
      ))}
    </>
  )
}

