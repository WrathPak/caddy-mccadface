/** Commands of the help system and Settings, so they are in the command palette and the shortcut list like everything else. */
import { BookOpen, GearSix, Keyboard, Sparkle } from '@phosphor-icons/react'
import { registerCommand } from '@/app/commands'
import { useSettingsDialog } from '@/ui/SettingsDialog'
import { useHelp } from './helpStore'

registerCommand({ id: 'help.open', label: 'Help', icon: BookOpen, category: 'App', shortcut: 'F1', run: () => useHelp.getState().show({ kind: 'start' }) })
registerCommand({ id: 'help.shortcuts', label: 'Keyboard Shortcuts', icon: Keyboard, category: 'App', run: () => useHelp.getState().show({ kind: 'shortcuts' }) })
registerCommand({ id: 'help.tour', label: 'Intro Tour', icon: Sparkle, category: 'App', run: () => useHelp.getState().startTour() })
registerCommand({ id: 'app.settings', label: 'Settings', icon: GearSix, category: 'App', run: () => useSettingsDialog.getState().show() })
