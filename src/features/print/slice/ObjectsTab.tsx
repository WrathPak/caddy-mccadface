/** The Objects tab: each body of the plate can carry its own settings, drawn with the same renderer at object scope. */
import { useEffect, useMemo, useState } from 'react'
import * as P from '@radix-ui/react-popover'
import { Cube, MagnifyingGlass, Plus, X } from '@phosphor-icons/react'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { plateObjects } from '../plate'
import { addObjectSetting, clearObject, editObject, removeObjectSetting } from './controller'
import { Cell } from './fields'
import { useSlicer } from './store'
import type { SliceProfile } from './profile'

function AddSetting({ id }: { id: string }) {
  const view = useSlicer((s) => s.objectView)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const form = view?.form
  const query = q.trim().toLowerCase()
  const have = new Set(view?.object?.groups.flatMap((g) => g.rows.map((r) => r.key)))
  return (
    <P.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ('') }}>
      <P.Trigger asChild><button type="button" className="btn" data-testid="add-object-setting"><Plus size={13} /> Add setting</button></P.Trigger>
      <P.Portal>
        <P.Content className="menu sl-pop" sideOffset={6} align="start" collisionPadding={12} data-testid="object-add-list">
          <label className="sl-search"><MagnifyingGlass size={13} /><input autoFocus placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="sl-list">
            {view?.object?.add.map((g) => {
              const keys = g.keys.filter((k) => !have.has(k) && form?.options[k] && (!query || `${form.options[k].label} ${k}`.toLowerCase().includes(query)))
              if (!keys.length) return null
              return (
                <div key={g.title}>
                  <div className="sl-grouphead">{g.title}</div>
                  {keys.map((k) => (
                    <button type="button" key={g.title + k} className="sl-item" data-testid={`add-${k}`} onClick={() => { setOpen(false); void addObjectSetting(id, k) }}>
                      <span>{form!.options[k].label}</span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </P.Content>
      </P.Portal>
    </P.Root>
  )
}

export function ObjectsTab({ profile }: { profile: SliceProfile }) {
  // the plate's bodies, kept current while the panel is open
  const geometry = useDoc((s) => s.geometry)
  const hidden = useUi((s) => s.hiddenIds)
  const objects = useMemo(() => plateObjects(), [geometry, hidden]) // eslint-disable-line react-hooks/exhaustive-deps
  const objectId = useSlicer((s) => s.objectId)
  const view = useSlicer((s) => s.objectView)
  const sel = objects.find((o) => o.id === objectId) ?? objects[0]
  useEffect(() => { if (sel && sel.id !== objectId) useSlicer.getState().set({ objectId: sel.id }) }, [sel, objectId])
  if (!objects.length) return <p className="sl-empty">There are no bodies on the plate yet.</p>
  const form = view?.form
  const own = sel ? profile.objects[sel.id] ?? {} : {}
  return (
    <div className="sl-objects" data-testid="objects-tab">
      <ul className="sl-objlist" aria-label="Bodies on the plate">
        {objects.map((o) => {
          const n = Object.keys(profile.objects[o.id] ?? {}).length
          return (
            <li key={o.id}>
              <button type="button" className="sl-objitem" data-active={o.id === sel?.id} data-testid={`object-${o.id}`} onClick={() => useSlicer.getState().set({ objectId: o.id, objectView: null })}>
                <Cube size={15} /><span className="sl-objname">{o.name}</span>{n > 0 && <span className="sl-badge on" title="Own settings">{n}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="sl-objpane">
        <div className="sl-objhead">
          <div><h3>{sel?.name}</h3><p className="sl-hint">Settings you add here apply to this body only. Everything else follows the process preset.</p></div>
          <div className="sl-objactions">
            {sel && <AddSetting id={sel.id} />}
            {Object.keys(own).length > 0 && <button type="button" className="btn" onClick={() => sel && void clearObject(sel.id)}>Reset all</button>}
          </div>
        </div>
        {view?.object?.groups.length === 0 && <p className="sl-empty" data-testid="object-empty">No own settings yet. Use Add setting, for example Infill density or Wall loops.</p>}
        {view?.object?.groups.map((g) => (
          <section className="sl-group" key={g.title}>
            <h4>{g.title}</h4>
            {g.rows.map((r) => {
              const opt = form?.options[r.key]
              if (!opt || !sel) return null
              return (
                <div className="sl-row" key={r.key} data-testid={`orow-${r.key}`} data-modified="true">
                  <button type="button" className="sl-mark on" aria-label={`Remove ${r.label ?? opt.label}`} onClick={() => void removeObjectSetting(sel.id, r.key)}><X size={11} weight="bold" /></button>
                  <span className="sl-label" title={opt.tooltip}>{r.label ?? opt.fullLabel ?? opt.label}</span>
                  <div className="sl-cells">
                    <span className="sl-cell">
                      <Cell opt={opt} cell={{ key: r.key, value: r.value, choices: r.choices, disabled: r.disabled ? true : undefined }} onEdit={(t) => void editObject(sel.id, r.key, t)} />
                      {r.inherited !== undefined && <span className="sl-inherit" title="The value without this override">was {r.inherited}</span>}
                    </span>
                  </div>
                </div>
              )
            })}
          </section>
        ))}
        {view?.issues?.filter((i) => i.severity !== 'info').map((i) => <p key={i.id + i.key} className="sl-issue-inline">{i.message}</p>)}
      </div>
    </div>
  )
}
