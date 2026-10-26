/** The read-only preview banner and the "Save with note" dialog. Mounted once in the app shell. */
import { useState } from 'react'
import { create } from 'zustand'
import { useDoc } from '@/doc/store'
import { saveDocument } from '@/io/actions'
import { Modal } from '@/ui/Modal'
import { exitPreview, restoreVersion } from './service'
import { useHistory } from './store'
import '@/app/platform.css'

export const useNoteDialog = create<{ open: boolean; set: (o: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }))

export function PreviewBanner() {
  const n = useHistory((s) => s.previewing)
  const readOnly = useDoc((s) => s.readOnly)
  if (n === null || !readOnly) return null
  return (
    <div className="preview-banner" role="status" data-testid="preview-banner">
      <span><b>Version {n}</b> is on show. It cannot be edited.</span>
      <button type="button" className="btn" onClick={() => void restoreVersion(n)}>Restore it</button>
      <button type="button" className="btn primary" onClick={() => void exitPreview()}>Back to the project</button>
    </div>
  )
}

export function NoteDialog() {
  const open = useNoteDialog((s) => s.open)
  const [text, setText] = useState('')
  if (!open) return null
  const close = () => { useNoteDialog.getState().set(false); setText('') }
  const save = () => { const note = text; close(); void saveDocument(false, note) }
  return (
    <Modal
      title="Save with a note"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="button" className="btn primary" onClick={save}>Save</button>
        </>
      }
    >
      <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>The note is kept with this version in the History panel.</div>
      <div className="inp">
        <input
          autoFocus
          aria-label="Note for this version"
          placeholder="What changed?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') save() }}
        />
      </div>
    </Modal>
  )
}
