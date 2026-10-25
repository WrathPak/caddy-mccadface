/** Commands and panels of the platform work: version history now; projects, plugins and the script editor register here too. */
import { ClockCounterClockwise, FolderSimple, NotePencil } from '@phosphor-icons/react'
import { registerCommand } from './commands'
import { openPanel, registerPanel } from './panels'
import { HistoryPanel } from '@/history/HistoryPanel'
import { useNoteDialog } from '@/history/HistoryUi'
import { ProjectsPanel } from '@/projects/ProjectsPanel'
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
