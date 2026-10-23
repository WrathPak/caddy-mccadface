/** Document-level UI: crash-recovery prompt, user Parameters dialog, drag-and-drop import. */
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { Plus, Trash } from '@phosphor-icons/react'
import { useDoc } from '@/doc/store'
import { formatParam, setUserParams } from '@/doc/params'
import type { UserParam } from '@/doc/types'
import { discardRecovery, importFiles, initPersistence, recover, useRecovery } from '@/io/actions'
import { Modal } from './Modal'

export const useParamsDialog = create<{ open: boolean; set: (o: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }))

function RecoveryPrompt() {
  const r = useRecovery((s) => s.record)
  if (!r) return null
  return (
    <Modal
      title="Recover unsaved work?"
      onClose={discardRecovery}
      footer={
        <>
          <button type="button" className="btn" onClick={discardRecovery}>Discard</button>
          <button type="button" className="btn primary" onClick={() => void recover()}>Recover</button>
        </>
      }
    >
      WeebCAD found an autosaved copy of <b>{r.name}</b> from {new Date(r.savedAt).toLocaleString()}. It was not saved to a file.
    </Modal>
  )
}

function ParametersDialog() {
  const open = useParamsDialog((s) => s.open)
  const close = () => useParamsDialog.getState().set(false)
  const userParams = useDoc((s) => s.userParams)
  const [rows, setRows] = useState<UserParam[]>([])
  useEffect(() => { if (open) setRows(userParams) }, [open, userParams])
  if (!open) return null

  // evaluate the draft rows for live feedback
  const scope = setUserParams(rows)
  setUserParams(userParams) // restore the committed scope
  const upd = (i: number, p: Partial<UserParam>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)))
  const apply = () => {
    const clean = rows.filter((r) => r.name.trim())
    useDoc.getState().setUserParams(clean.map((r) => ({ name: r.name.trim(), expr: r.expr.trim() || '0' })))
    close()
  }
  return (
    <Modal
      title="Parameters"
      width={520}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn primary" onClick={apply}>OK</button>
        </>
      }
    >
      <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>
        Name a value (for example <span className="mono">width = 40 mm</span>) and use the name in any number field, such as <span className="mono">width / 2</span>.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 90px 22px', gap: 4, alignItems: 'center' }}>
        <span className="field-label" style={{ color: 'var(--text-faint)' }}>Name</span>
        <span style={{ color: 'var(--text-faint)' }}>Expression</span>
        <span style={{ color: 'var(--text-faint)' }}>Value</span>
        <span />
        {rows.map((r, i) => {
          const err = scope.errors[r.name]
          return (
            <Fragment key={i}>
              <div className="inp"><input value={r.name} spellCheck={false} onChange={(e) => upd(i, { name: e.target.value })} /></div>
              <div className={'inp' + (err ? ' err' : '')} title={err}><input value={r.expr} spellCheck={false} onChange={(e) => upd(i, { expr: e.target.value })} /></div>
              <span className="mono" style={{ color: err ? 'var(--danger)' : 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {err ? 'error' : formatParam(scope.values[r.name])}
              </span>
              <button type="button" className="rbtn small" style={{ minWidth: 0, padding: 2 }} onClick={() => setRows(rows.filter((_, k) => k !== i))}><Trash size={13} /></button>
            </Fragment>
          )
        })}
      </div>
      <button type="button" className="btn" style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => setRows([...rows, { name: 'param' + (rows.length + 1), expr: '10 mm' }])}>
        <Plus size={12} /> Add parameter
      </button>
    </Modal>
  )
}


/** Mount once in the App: dialogs plus startup persistence and file drops. */
export function DocUi() {
  useEffect(() => {
    void initPersistence()
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault() }
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return
      e.preventDefault()
      void importFiles([...e.dataTransfer.files])
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return (
    <>
      <RecoveryPrompt />
      <ParametersDialog />
    </>
  )
}
