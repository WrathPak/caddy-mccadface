/** Configurations: a table of user-parameter sets (S / M / L) listed in the Browser, switched with a click, edited in a dialog. */
import { Fragment, useEffect, useState } from 'react'
import { create } from 'zustand'
import { CaretDown, CaretRight, Check, Pencil, Plus, Trash } from '@phosphor-icons/react'
import { formatParam, setUserParams, effectiveParams } from '@/doc/params'
import { useDoc } from '@/doc/store'
import type { Config } from '@/doc/types'
import { Modal } from '@/ui/Modal'

export const useConfigDialog = create<{ open: boolean; set(o: boolean): void }>((set) => ({ open: false, set: (open) => set({ open }) }))

function ConfigDialog() {
  const open = useConfigDialog((s) => s.open)
  const configs = useDoc((s) => s.configs)
  const params = useDoc((s) => s.userParams)
  const active = useDoc((s) => s.activeConfig)
  const [rows, setRows] = useState<Config[]>([])
  useEffect(() => { if (open) setRows(configs.map((c) => ({ name: c.name, values: { ...c.values } }))) }, [open, configs])
  if (!open) return null
  const close = () => useConfigDialog.getState().set(false)
  const upd = (i: number, f: (c: Config) => Config) => setRows(rows.map((r, k) => (k === i ? f(r) : r)))
  const dupe = rows.some((r, i) => !r.name.trim() || rows.findIndex((x) => x.name.trim() === r.name.trim()) !== i)
  // the value each cell would give, for live feedback
  const shown = (c: Config, name: string) => {
    const scope = setUserParams(effectiveParams(params, [c], c.name))
    setUserParams(effectiveParams(params, configs, active))
    return scope.errors[name] ? 'error' : formatParam(scope.values[name])
  }
  const apply = () => {
    useDoc.getState().setConfigs(rows.map((r) => ({ name: r.name.trim(), values: Object.fromEntries(Object.entries(r.values).filter(([, v]) => v.trim())) })))
    close()
  }
  return (
    <Modal
      title="Configurations"
      width={Math.min(900, 220 + params.length * 130)}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn primary" disabled={dupe} title={dupe ? 'Every configuration needs its own name' : undefined} data-testid="config-ok" onClick={apply}>OK</button>
        </>
      }
    >
      {params.length === 0 ? (
        <div style={{ color: 'var(--text-dim)' }}>Add some parameters first (Document &gt; Parameters), then give each configuration its own values for them.</div>
      ) : (
        <>
          <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>
            Each row is a configuration. Leave a cell empty to keep the parameter&apos;s normal value. Switch between them in the Browser; export each one from the Export dialog.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `140px repeat(${params.length}, minmax(100px, 1fr)) 22px`, gap: 4, alignItems: 'center' }}>
            <span style={{ color: 'var(--text-faint)' }}>Name</span>
            {params.map((p) => <span key={p.name} className="mono" style={{ color: 'var(--text-faint)' }} title={`Normal value: ${p.expr}`}>{p.name}</span>)}
            <span />
            {rows.map((r, i) => (
              <Fragment key={i}>
                <div className="inp"><input data-testid={`config-name-${i}`} value={r.name} spellCheck={false} onChange={(e) => upd(i, (c) => ({ ...c, name: e.target.value }))} /></div>
                {params.map((p) => (
                  <div key={p.name} className="inp" title={`= ${shown(r, p.name)}`}>
                    <input data-testid={`config-${i}-${p.name}`} value={r.values[p.name] ?? ''} placeholder={p.expr} spellCheck={false}
                      onChange={(e) => upd(i, (c) => ({ ...c, values: { ...c.values, [p.name]: e.target.value } }))} />
                  </div>
                ))}
                <button type="button" className="rbtn small" style={{ minWidth: 0, padding: 2 }} aria-label="Remove configuration" onClick={() => setRows(rows.filter((_, k) => k !== i))}><Trash size={13} /></button>
              </Fragment>
            ))}
          </div>
          <button type="button" className="btn" data-testid="config-add" style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 4 }}
            onClick={() => setRows([...rows, { name: ['S', 'M', 'L', 'XL'][rows.length] ?? `Config ${rows.length + 1}`, values: {} }])}>
            <Plus size={12} /> Add configuration
          </button>
        </>
      )}
    </Modal>
  )
}

/** The Configurations folder of the Browser tree. */
export function ConfigurationsGroup({ depth }: { depth: number }) {
  const [open, setOpen] = useState(true)
  const configs = useDoc((s) => s.configs)
  const active = useDoc((s) => s.activeConfig)
  const pad = (d: number) => ({ paddingLeft: 4 + d * 12 })
  const row = (key: string, label: string, on: boolean, click: () => void, extra?: React.ReactNode) => (
    <div key={key} className="tree-row" data-selected={on} data-testid={'config-row-' + key} style={pad(depth + 1)} onClick={click}>
      <span className="caret" />
      <span style={{ display: 'inline-flex', color: 'var(--text-dim)' }}>{on ? <Check size={13} /> : null}</span>
      <span className="name">{label}</span>
      {extra}
    </div>
  )
  return (
    <>
      <div className="tree-row group" style={pad(depth)} data-testid="configs-group" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? <CaretDown size={9} weight="bold" /> : <CaretRight size={9} weight="bold" />}</span>
        <span style={{ display: 'inline-flex', color: 'var(--text-dim)' }}><Pencil size={13} /></span>
        <span className="name">Configurations{active ? `: ${active}` : ''}</span>
      </div>
      {open && (
        <>
          {configs.length > 0 && row('base', 'Base parameters', active === null, () => useDoc.getState().setActiveConfig(null))}
          {configs.map((c) => row(c.name, c.name, active === c.name, () => useDoc.getState().setActiveConfig(c.name)))}
          {row('edit', configs.length ? 'Edit configurations...' : 'Add configurations...', false, () => useConfigDialog.getState().set(true))}
        </>
      )}
      <ConfigDialog />
    </>
  )
}
