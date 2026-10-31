/** Small, non-blocking prompts: the one-time autosave folder card, the reconnect button, and the "Update ready" button of the status bar. */
import { useEffect, useState } from 'react'
import { autosaveOffForTests } from '@/io/actions'
import { canPickFolder, useProjects } from '@/projects/store'
import { useSettings } from '@/settings/settings'
import { applyUpdate, useUpdate } from '@/app/updates'
import { useDevice } from '@/app/device'
import { Tip } from './Tooltip'

/**
 * First launch, and every launch until it is answered: autosave keeps copies in a folder the person picks. Picking needs a click,
 * which is why this is a card and not something that happens by itself. Only where the browser can pick a folder (Chrome, Edge).
 * "Not now" is remembered, and Settings > General can still pick the folder later.
 */
export function AutosaveCard() {
  const asked = useSettings((s) => s.autosaveFolderAsked)
  const setAsked = useSettings((s) => s.setAutosaveFolderAsked)
  const on = useSettings((s) => s.autosave && s.diskAutosave)
  // after the intro tour, so the two never share the screen
  const tourSeen = useSettings((s) => s.tourSeen)
  const compact = useDevice((s) => s.compact)
  const quiet = tourSeen || compact
  const root = useProjects((s) => s.root)
  const [looked, setLooked] = useState(false)
  // a folder picked in an earlier session comes back first: someone who already chose one must not see the card flash up
  useEffect(() => {
    if (autosaveOffForTests()) return
    void useProjects.getState().init().finally(() => setLooked(true))
  }, [])
  if (autosaveOffForTests() || !looked || asked || root || !on || !quiet || !canPickFolder()) return null
  const pick = async () => {
    await useProjects.getState().chooseFolder()
    // a cancelled picker leaves the card up
    if (useProjects.getState().root) setAsked(true)
  }
  return (
    <div role="region" aria-label="Autosave folder" data-testid="autosave-card"
      style={{ position: 'fixed', left: 12, bottom: 34, zIndex: 1500, width: 300, maxWidth: 'calc(100vw - 24px)', padding: 10, background: 'var(--bg-2)', border: '1px solid var(--line-strong)', borderRadius: 3, boxShadow: 'var(--shadow-float)', fontSize: 'var(--fs-md)' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Keep autosave copies in a folder?</div>
      <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>
        Autosave keeps copies of your work in a folder you pick, on top of the copy in this browser. A crash or a cleared browser then never costs you your work.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button type="button" className="btn" data-testid="autosave-card-later" onClick={() => setAsked(true)}>Not now</button>
        <button type="button" className="btn primary" data-testid="autosave-card-pick" onClick={() => void pick()}>Pick folder</button>
      </div>
    </div>
  )
}

/** The folder was picked in an earlier session and the browser wants a click before it gives access back. One click, no dialog of ours. */
export function ReconnectCell() {
  const root = useProjects((s) => s.root)
  const access = useProjects((s) => s.access)
  const on = useSettings((s) => s.autosave && s.diskAutosave)
  const compact = useDevice((s) => s.compact)
  if (!root || access !== 'prompt' || !on) return null
  return (
    <Tip label="Reconnect autosave folder" desc={`The browser needs one click to let CADdy McCADFace write to "${root.name}" again. Until then autosave keeps its copy in the browser only.`} side="top">
      <button type="button" className="cell" data-testid="reconnect-autosave" onClick={() => void useProjects.getState().reconnect()}>
        <span style={{ color: 'var(--accent)' }}>{compact ? 'Reconnect' : 'Reconnect autosave folder'}</span>
      </button>
    </Tip>
  )
}

/** A new version is waiting. Saves, then reloads onto it, when clicked; until then nothing changes. */
export function UpdateCell() {
  const { ready, switched, applying } = useUpdate()
  if (!ready) return null
  const label = applying ? 'Saving ...' : switched ? 'Reload to update' : 'Update ready'
  return (
    <Tip label={switched ? 'Reload to finish the update' : 'Update ready'}
      desc={switched ? 'The app was updated in another tab. This tab saves your work, then reloads onto the new version.' : 'A new version is ready. Click to save your work and reload onto it. If you leave it, it installs by itself the next time the app is opened.'} side="top">
      <button type="button" className="cell" data-testid="update-ready" disabled={applying} onClick={() => void applyUpdate()}>
        <span style={{ color: 'var(--accent)' }}>{label}</span>
      </button>
    </Tip>
  )
}
