import { useEffect, useMemo, useState } from 'react'
import * as CM from '@radix-ui/react-context-menu'
import { ArrowCounterClockwise, CaretDown, CaretRight, Copy, Cube, FilePlus, Folder, FolderOpen, FolderPlus, MagnifyingGlass, PencilSimple, Trash, ArrowsClockwise, Plugs } from '@phosphor-icons/react'
import { useProjects, keyOf, canPickFolder } from './store'
import { baseOf, filterNodes, type DirNode, type FileNode } from './library'
import { readThumbnail } from './zipThumb'
import { componentInserter } from './insert'
import '@/app/platform.css'

const thumbs = new Map<string, Promise<string | null>>()

/** Object URL of the thumbnail stored in a project, read once per file version. */
function thumbUrl(n: FileNode): Promise<string | null> {
  const k = `${keyOf(n)}@${n.modified}@${n.size}`
  let p = thumbs.get(k)
  if (!p) {
    p = (async () => {
      const blob = await readThumbnail(await n.handle.getFile())
      return blob ? URL.createObjectURL(blob) : null
    })().catch(() => null)
    thumbs.set(k, p)
  }
  return p
}

function Thumb({ node }: { node: FileNode }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void thumbUrl(node).then((u) => live && setUrl(u))
    return () => { live = false }
  }, [node])
  return <span className="pf-thumb" data-testid="project-thumb" data-has={url ? 'yes' : 'no'}>{url ? <img src={url} alt="" /> : <Cube size={18} />}</span>
}

const sizeText = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)
const dateText = (t: number) => (t ? new Date(t).toLocaleDateString() : '')

function Row({ node, depth, showPath }: { node: FileNode; depth: number; showPath?: boolean }) {
  const { selected, renaming, select, open, startRename, rename, duplicate, trashFile } = useProjects()
  const k = keyOf(node)
  const isSel = selected === k
  const inserter = componentInserter.fn
  const row = (
    <div
      className="pf-item"
      role="listitem"
      data-testid="project-row"
      data-name={node.name}
      data-selected={isSel}
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={() => select(k)}
      onDoubleClick={() => void open(node)}
    >
      <Thumb node={node} />
      <span className="main">
        {renaming === k ? (
          <input
            className="rename"
            autoFocus
            aria-label="Project name"
            defaultValue={baseOf(node.name)}
            style={{ height: 18, background: 'var(--bg-input)', border: '1px solid var(--accent)', color: 'var(--text)', outline: 'none', fontSize: 'var(--fs-md)', padding: '0 3px', borderRadius: 2, userSelect: 'text' }}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onBlur={() => startRename(null)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') void rename(node, e.currentTarget.value)
              if (e.key === 'Escape') startRename(null)
            }}
          />
        ) : (
          <span className="title">{baseOf(node.name)}</span>
        )}
        <span className="meta">{showPath && node.path.length ? node.path.join(' / ') + ' - ' : ''}{dateText(node.modified)} - {sizeText(node.size)}</span>
      </span>
    </div>
  )
  return (
    <CM.Root>
      <CM.Trigger asChild>{row}</CM.Trigger>
      <CM.Portal>
        <CM.Content className="menu">
          <CM.Item className="menu-item" onSelect={() => void open(node)}><FolderOpen size={14} /> Open</CM.Item>
          {inserter && (
            <CM.Item className="menu-item" onSelect={() => void inserter(node)}><Plugs size={14} /> Insert as component</CM.Item>
          )}
          <CM.Separator className="menu-sep" />
          <CM.Item className="menu-item" onSelect={() => startRename(k)}><PencilSimple size={14} /> Rename</CM.Item>
          <CM.Item className="menu-item" onSelect={() => void duplicate(node)}><Copy size={14} /> Duplicate</CM.Item>
          <CM.Item className="menu-item" onSelect={() => void trashFile(node)}><Trash size={14} /> Move to trash</CM.Item>
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  )
}

function Folder_({ dir, depth }: { dir: DirNode; depth: number }) {
  const { collapsed, toggleFolder, newProject } = useProjects()
  const k = dir.path.join('/')
  const open = !collapsed[k]
  return (
    <>
      <CM.Root>
        <CM.Trigger asChild>
          <div className="pf-folder" role="listitem" data-testid="project-folder" style={{ paddingLeft: 6 + depth * 12 }} onClick={() => toggleFolder(k)}>
            {open ? <CaretDown size={9} weight="bold" /> : <CaretRight size={9} weight="bold" />}
            <Folder size={13} /> {dir.name}
          </div>
        </CM.Trigger>
        <CM.Portal>
          <CM.Content className="menu">
            <CM.Item className="menu-item" onSelect={() => void newProject(dir)}><FilePlus size={14} /> New project here</CM.Item>
          </CM.Content>
        </CM.Portal>
      </CM.Root>
      {open && <Children dir={dir} depth={depth + 1} />}
    </>
  )
}

function Children({ dir, depth }: { dir: DirNode; depth: number }) {
  return (
    <>
      {dir.children.map((c) => (c.kind === 'dir' ? <Folder_ key={c.path.join('/')} dir={c} depth={depth} /> : <Row key={keyOf(c)} node={c} depth={depth} />))}
    </>
  )
}

function NewFolderButton() {
  const newFolder = useProjects((s) => s.newFolder)
  const [name, setName] = useState<string | null>(null)
  if (name === null) return <button type="button" className="btn" onClick={() => setName('')}><FolderPlus size={13} /> Folder</button>
  return (
    <span className="inp" style={{ width: 120 }}>
      <input
        autoFocus
        aria-label="Folder name"
        placeholder="Folder name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => setName(null)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && name.trim()) { void newFolder(name); setName(null) }
          if (e.key === 'Escape') setName(null)
        }}
      />
    </span>
  )
}

export function ProjectsPanel() {
  const { root, access, tree, files, trash, loading, error, query, recent, collapsed, init, chooseFolder, reconnect, forget, refresh, setQuery, newProject, toggleFolder, restore } = useProjects()
  useEffect(() => { void init() }, [init])

  const found = useMemo(() => (query.trim() ? filterNodes(files, query) : null), [files, query])
  const recents = useMemo(() => {
    const byKey = new Map(files.map((f) => [keyOf(f), f]))
    return recent.map((r) => byKey.get(keyOf(r))).filter((f): f is FileNode => !!f).slice(0, 5)
  }, [recent, files])

  if (!root) {
    return (
      <div className="pf-panel" data-testid="projects-panel">
        <div className="pf-head"><Folder size={14} /><b className="grow">Projects</b></div>
        <div className="pf-empty">
          Pick a folder on your computer and its projects (<span className="mono">.caddy</span> files) show up here with a preview. Nothing is uploaded: the files stay where they are.
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn primary" disabled={!canPickFolder()} onClick={() => void chooseFolder()}><FolderOpen size={14} /> Choose folder</button>
          </div>
          {!canPickFolder() && <div style={{ marginTop: 8 }}>This browser cannot pick a folder. Chrome and Edge can.</div>}
        </div>
      </div>
    )
  }

  if (access !== 'granted') {
    return (
      <div className="pf-panel" data-testid="projects-panel">
        <div className="pf-head"><Folder size={14} /><b className="grow">{root.name}</b></div>
        <div className="pf-empty">
          The browser needs your OK again to read this folder.
          <div className="pf-actions" style={{ marginTop: 10 }}>
            <button type="button" className="btn primary" onClick={() => void reconnect()}>Allow access</button>
            <button type="button" className="btn" onClick={() => void chooseFolder()}>Choose another folder</button>
          </div>
        </div>
      </div>
    )
  }

  const trashOpen = !collapsed['.trash']
  return (
    <div className="pf-panel" data-testid="projects-panel">
      <div className="pf-head">
        <Folder size={14} />
        <b className="grow" title={root.name}>{root.name}</b>
        <button type="button" className="btn" aria-label="Refresh" title="Read the folder again" onClick={() => void refresh()}><ArrowsClockwise size={13} /></button>
        <button type="button" className="btn" onClick={() => void chooseFolder()} title="Pick a different folder">Change</button>
      </div>
      <div className="pf-head">
        <label className="inp pf-search"><MagnifyingGlass size={12} style={{ color: 'var(--text-faint)', marginRight: 4 }} /><input aria-label="Search projects" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <button type="button" className="btn" onClick={() => void newProject()}><FilePlus size={13} /> New</button>
        <NewFolderButton />
      </div>
      <div className="pf-scroll" role="list">
        {error && <div className="panel-error">{error}</div>}
        {loading && !files.length && <div className="pf-empty">Reading the folder...</div>}
        {found ? (
          <>
            {found.length === 0 && <div className="pf-empty">No project matches "{query}".</div>}
            {found.map((n) => <Row key={keyOf(n)} node={n} depth={0} showPath />)}
          </>
        ) : (
          <>
            {recents.length > 0 && (
              <>
                <div className="pf-section">Recent<span className="line" /></div>
                {recents.map((n) => <Row key={'r:' + keyOf(n)} node={n} depth={0} showPath />)}
              </>
            )}
            <div className="pf-section">All projects<span className="line" /></div>
            {tree && tree.children.length === 0 && !loading && <div className="pf-empty">No projects in this folder yet. Use New to make one, or save the open project into it.</div>}
            {tree && <Children dir={tree} depth={0} />}
            {trash.length > 0 && (
              <>
                <div className="pf-folder" role="listitem" style={{ marginTop: 6 }} onClick={() => toggleFolder('.trash')}>
                  {trashOpen ? <CaretDown size={9} weight="bold" /> : <CaretRight size={9} weight="bold" />}
                  <Trash size={13} /> Trash ({trash.length})
                </div>
                {trashOpen && trash.map((t) => (
                  <div key={t.name} className="pf-item" role="listitem" data-testid="trash-row" style={{ paddingLeft: 20 }}>
                    <span className="main">
                      <span className="title">{baseOf(t.name)}</span>
                      <span className="meta">{dateText(t.modified)} - {sizeText(t.size)}</span>
                    </span>
                    <button type="button" className="btn" onClick={() => void restore(t.name)}><ArrowCounterClockwise size={12} /> Restore</button>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
      <div className="pf-foot">
        <span className="pf-sub">Double-click a project to open it. Right-click for more. Deleted projects go to the trash folder inside this folder.</span>
        <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => void forget()}>Stop using this folder</button>
      </div>
    </div>
  )
}
