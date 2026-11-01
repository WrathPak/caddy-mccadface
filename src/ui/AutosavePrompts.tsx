/** Non-blocking prompts: the one-time autosave folder card, the centred update card, the reconnect button, and the "Update ready" pill of the status bar. */
import { useEffect, useState, type CSSProperties } from 'react'
import { autosaveOffForTests } from '@/io/actions'
import { canPickFolder, useProjects } from '@/projects/store'
import { useSettings } from '@/settings/settings'
import { applyUpdate, useUpdate } from '@/app/updates'
import { installApp, useInstall } from '@/app/install'
import { useDevice } from '@/app/device'
import { Tip } from './Tooltip'

/** Middle of the screen, where it gets seen, but not modal: the app stays usable around it. */
const CENTRED: CSSProperties = {
  position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 1500, width: 340, maxWidth: 'calc(100vw - 24px)',
  padding: 12, background: 'var(--bg-2)', border: '1px solid var(--line-strong)', borderRadius: 3, boxShadow: 'var(--shadow-float)', fontSize: 'var(--fs-md)',
}

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
  // the update card takes the same spot and goes first
  const updateCard = useUpdate((s) => s.ready && !s.cardDismissed)
  const [looked, setLooked] = useState(false)
  // a folder picked in an earlier session comes back first: someone who already chose one must not see the card flash up
  useEffect(() => {
    if (autosaveOffForTests()) return
    void useProjects.getState().init().finally(() => setLooked(true))
  }, [])
  if (autosaveOffForTests() || updateCard || !looked || asked || root || !on || !quiet || !canPickFolder()) return null
  const pick = async () => {
    await useProjects.getState().chooseFolder()
    // a cancelled picker leaves the card up
    if (useProjects.getState().root) setAsked(true)
  }
  return (
    <div role="region" aria-label="Autosave folder" data-testid="autosave-card"
      style={CENTRED}>
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

/** A new version is waiting and this tab has work open: asked in the middle of the screen. "Later" leaves the status bar pill. */
export function UpdateCard() {
  const { ready, switched, applying, cardDismissed } = useUpdate()
  if (!ready || cardDismissed) return null
  return (
    <div role="region" aria-label="Update" data-testid="update-card" style={CENTRED}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{switched ? 'Reload to finish the update' : 'A new version is ready'}</div>
      <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>
        {switched
          ? 'The app was updated in another tab. Reloading saves your work first, then opens it again on the new version.'
          : 'Updating saves your work first, then reloads onto the new version. Later keeps an Update button in the status bar.'}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button type="button" className="btn" data-testid="update-card-later" disabled={applying} onClick={() => useUpdate.setState({ cardDismissed: true })}>Later</button>
        <button type="button" className="btn primary" data-testid="update-card-now" disabled={applying} onClick={() => void applyUpdate()}>
          {applying ? 'Saving ...' : switched ? 'Reload now' : 'Update now'}
        </button>
      </div>
    </div>
  )
}

/**
 * Once, where the browser can install the app: offered after the tour, the autosave card and any update card are out of the way.
 * "Not now" is remembered; Settings > General keeps the Install button.
 */
export function InstallCard() {
  const asked = useSettings((s) => s.installAsked)
  const setAsked = useSettings((s) => s.setInstallAsked)
  const tourSeen = useSettings((s) => s.tourSeen)
  const folderAnswered = useSettings((s) => s.autosaveFolderAsked || !s.autosave || !s.diskAutosave)
  const root = useProjects((s) => s.root)
  const can = useInstall((s) => !!s.prompt && !s.installed)
  const updateCard = useUpdate((s) => s.ready && !s.cardDismissed)
  if (asked || !can || !tourSeen || updateCard || (!folderAnswered && !root && canPickFolder())) return null
  return (
    <div role="region" aria-label="Install app" data-testid="install-card" style={CENTRED}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Install CADdy McCADFace?</div>
      <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>
        It gets its own window and icon, and opens with no internet. Nothing about your files changes: they stay on this computer either way.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button type="button" className="btn" data-testid="install-card-later" onClick={() => setAsked(true)}>Not now</button>
        <button type="button" className="btn primary" data-testid="install-card-install" onClick={() => { setAsked(true); void installApp() }}>Install</button>
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
