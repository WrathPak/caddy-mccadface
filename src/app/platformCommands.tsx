/** Commands and panels of the platform work: version history now; projects, plugins and the script editor register here too. */
import { lazy, Suspense } from 'react'
import { ClockCounterClockwise, FolderSimple, NotePencil, PuzzlePiece, Terminal } from '@phosphor-icons/react'
import { registerCommand } from './commands'
import { openPanel, registerPanel } from './panels'
import { HistoryPanel } from '@/history/HistoryPanel'
import { useNoteDialog } from '@/history/HistoryUi'
import { ProjectsPanel } from '@/projects/ProjectsPanel'
import { PluginsPanel } from '@/api/PluginsPanel'
import '@/history/service'

registerPanel({ id: 'history', title: 'History', render: () => <HistoryPanel /> })
registerCommand({
  id: 'view.history',
  label: 'History',
  tip: 'Every save keeps a version of the project inside the file: look at one, compare two, or go back to one',
  icon: ClockCounterClockwise,
  category: 'Document',
  run: () => openPanel('history'),
})
registerCommand({
  id: 'file.saveNote',
  label: 'Save with Note...',
  tip: 'Save, and keep a note with this version in the History panel',
  icon: NotePencil,
  category: 'File',
  run: () => useNoteDialog.getState().set(true),
})

registerPanel({ id: 'projects', title: 'Projects', render: () => <ProjectsPanel /> })
registerCommand({
  id: 'view.projects',
  label: 'Projects',
  tip: 'Browse the projects in a folder on your computer, with previews, search, recent files and a trash',
  icon: FolderSimple,
  category: 'File',
  run: () => openPanel('projects'),
})

registerPanel({ id: 'plugins', title: 'Plugins', render: () => <PluginsPanel /> })
registerCommand({
  id: 'view.plugins',
  label: 'Plugins',
  tip: 'Add, switch on and off, and read the log of plugins (small programs that add features and commands)',
  icon: PuzzlePiece,
  category: 'App',
  run: () => openPanel('plugins'),
})

// the editor (CodeMirror) is its own chunk: it is only fetched when the panel is first opened
const ScriptPanel = lazy(() => import('@/api/ScriptPanel').then((m) => ({ default: m.ScriptPanel })))
registerPanel({
  id: 'script',
  title: 'Script',
  render: () => <Suspense fallback={<div className="pf-empty">Loading the editor...</div>}><ScriptPanel /></Suspense>,
  floating: { width: 640, height: 480 },
})
registerCommand({
  id: 'view.script',
  label: 'Script',
  tip: 'Write and run a quick script against the plugin API',
  icon: Terminal,
  category: 'App',
  run: () => openPanel('script'),
})
