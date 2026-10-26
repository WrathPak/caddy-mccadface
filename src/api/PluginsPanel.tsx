import { useEffect, useRef, useState } from 'react'
import { DownloadSimple, FileJs, FolderOpen, PuzzlePiece } from '@phosphor-icons/react'
import { Modal, toast } from '@/ui/Modal'
import { pickFiles } from '@/io/files'
import { filesFromHandle, filesFromInput, packageFromFile, packageFromFolder, usePlugins, type Package, type PluginRecord } from './pluginStore'
import '@/app/platform.css'

const PERMISSION_TEXT: Record<string, string> = {
  'document:write': 'Change the document (add, edit and delete features)',
  'commands:run': 'Run any command of the app',
  download: 'Offer files for download',
}

const stateText = (s: string | undefined, err: string | null | undefined) =>
  s === 'running' ? 'Running' : s === 'starting' ? 'Starting...' : s === 'failed' ? `Stopped: ${err ?? 'it failed'}` : 'Switched off'

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className="pf-switch" onClick={() => onChange(!on)} />
}

function Row({ r }: { r: PluginRecord }) {
  const status = usePlugins((s) => s.status[r.id])
  const { setEnabled, setGranted, remove, restart } = usePlugins()
  const [showLog, setShowLog] = useState(false)
  const lines = status?.logs ?? []
  return (
    <div className="pf-item pf-plug" role="listitem" data-testid="plugin-row" data-plugin={r.id} style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
      <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8 }}>
        <Switch on={r.enabled} label={`Switch ${r.name} ${r.enabled ? 'off' : 'on'}`} onChange={(v) => void setEnabled(r.id, v)} />
        <span className="main">
          <span className="title"><b>{r.name}</b> {r.version && <span className="pf-sub">v{r.version}</span>}</span>
          {r.description && <span className="meta" style={{ whiteSpace: 'normal' }}>{r.description}</span>}
        </span>
      </div>
      <div className="meta" data-testid="plugin-state" style={{ color: status?.state === 'failed' ? 'var(--danger)' : undefined, whiteSpace: 'normal' }}>
        {stateText(status?.state ?? (r.enabled ? 'starting' : 'stopped'), status?.error)}
        {status?.state === 'running' && ` - ${status.features} ${status.features === 1 ? 'feature' : 'features'}, ${status.commands} ${status.commands === 1 ? 'command' : 'commands'}`}
        {' '}<span className="pf-sub">from {r.origin}</span>
      </div>
      {status?.problems.map((p, i) => <div key={i} className="err">{p}</div>)}
      {r.permissions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="pf-sub">Asks to:</span>
          {r.permissions.map((p) => (
            <label key={p} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={r.granted.includes(p)} aria-label={`Allow: ${PERMISSION_TEXT[p] ?? p}`} onChange={(e) => void setGranted(r.id, e.target.checked ? [...r.granted, p] : r.granted.filter((x) => x !== p))} />
              {PERMISSION_TEXT[p] ?? p}
            </label>
          ))}
        </div>
      )}
      <div className="pf-actions">
        <button type="button" className="btn" onClick={() => void restart(r.id)} disabled={!r.enabled}>Restart</button>
        <button type="button" className="btn" onClick={() => setShowLog(!showLog)}>{showLog ? 'Hide log' : 'Log'}</button>
        <button type="button" className="btn danger" onClick={() => { if (window.confirm(`Remove ${r.name}?`)) void remove(r.id) }}>Remove</button>
      </div>
      {showLog && (
        <div className="script-console" style={{ height: 120, width: '100%', boxSizing: 'border-box' }} data-testid="plugin-log">
          {lines.length === 0 && <div className="ln info">Nothing logged yet.</div>}
          {lines.slice(-100).map((l, i) => <div key={i} className={'ln ' + l.level}>{l.text}</div>)}
        </div>
      )}
    </div>
  )
}

/** The question before a plugin is added: what it asks for. */
function AddDialog({ pkg, onClose }: { pkg: Package; onClose: () => void }) {
  const install = usePlugins((s) => s.install)
  const existing = usePlugins((s) => s.records.find((r) => r.id === pkg.id))
  const [granted, setGranted] = useState<string[]>(pkg.permissions)
  return (
    <Modal
      title={existing ? `Update ${pkg.name}?` : `Add ${pkg.name}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={async () => { onClose(); const r = await install(pkg, granted); toast(`${r.name} added`) }}>{existing ? 'Update' : 'Add plugin'}</button>
        </>
      }
    >
      <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>
        {pkg.description || 'A plugin adds features and commands to the app. It runs in a sandbox: it cannot reach your files, the page or the network.'}
      </div>
      {pkg.permissions.length ? (
        <>
          <div style={{ marginBottom: 4 }}>It asks to:</div>
          {pkg.permissions.map((p) => (
            <label key={p} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
              <input type="checkbox" checked={granted.includes(p)} aria-label={PERMISSION_TEXT[p] ?? p} onChange={(e) => setGranted(e.target.checked ? [...granted, p] : granted.filter((x) => x !== p))} />
              {PERMISSION_TEXT[p] ?? p}
            </label>
          ))}
        </>
      ) : (
        <div className="pf-sub">It asks for nothing beyond reading the document and building geometry.</div>
      )}
      <div className="pf-sub" style={{ marginTop: 8 }}>{Object.keys(pkg.files).length} {Object.keys(pkg.files).length === 1 ? 'file' : 'files'}, from {pkg.origin}</div>
    </Modal>
  )
}

export function PluginsPanel() {
  const { records, load } = usePlugins()
  const [pkg, setPkg] = useState<Package | null>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  useEffect(() => { void load() }, [load])

  const guard = async (fn: () => Promise<Package | null>) => {
    try {
      const p = await fn()
      if (p) setPkg(p)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }
  const addFile = () => guard(async () => {
    const [f] = await pickFiles('.js,.mjs')
    return f ? packageFromFile(f) : null
  })
  const addFolder = () => guard(async () => {
    const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
    if (picker) {
      const dir = await picker({ id: 'caddy-plugin', mode: 'read' })
      return packageFromFolder(dir.name, await filesFromHandle(dir))
    }
    folderInput.current?.click()
    return null
  })
  const apiHref = `${import.meta.env.BASE_URL}caddy-api.d.ts`

  return (
    <div className="pf-panel" data-testid="plugins-panel">
      <div className="pf-head">
        <PuzzlePiece size={14} />
        <b className="grow">Plugins</b>
        <button type="button" className="btn" onClick={() => void addFile()}><FileJs size={13} /> File</button>
        <button type="button" className="btn" onClick={() => void addFolder()}><FolderOpen size={13} /> Folder</button>
      </div>
      <input
        ref={folderInput}
        type="file"
        // @ts-expect-error webkitdirectory is not in the DOM typings
        webkitdirectory=""
        multiple
        hidden
        data-testid="plugin-folder-input"
        onChange={(e) => {
          const list = [...(e.target.files ?? [])]
          e.target.value = ''
          if (!list.length) return
          const { name, files } = filesFromInput(list)
          void guard(() => packageFromFolder(name, files))
        }}
      />
      <div className="pf-scroll" role="list">
        {records.length === 0 && (
          <div className="pf-empty">
            Plugins add features, commands and ribbon buttons. Add a single <span className="mono">.js</span> file, or a folder with an <span className="mono">index.js</span> and an optional <span className="mono">plugin.json</span>. They run in a sandbox with no access to the page or the network.
            <div style={{ marginTop: 8 }}>The <span className="mono">examples/plugins</span> folder of the project has two to start from.</div>
          </div>
        )}
        {records.map((r) => <Row key={r.id} r={r} />)}
      </div>
      <div className="pf-foot">
        <a className="btn" style={{ alignSelf: 'flex-start', textDecoration: 'none', color: 'inherit' }} href={apiHref} download="caddy-api.d.ts" data-testid="api-types-link"><DownloadSimple size={13} /> API types (caddy-api.d.ts)</a>
        <span className="pf-sub">Put the file next to your plugin and reference it for completion in your editor. Plugin authoring is described in docs/plugins.md.</span>
      </div>
      {pkg && <AddDialog pkg={pkg} onClose={() => setPkg(null)} />}
    </div>
  )
}

