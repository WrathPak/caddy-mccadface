import { allCommands, runCommand, type Command } from './commands'
import { useUi } from '@/store/ui'

interface Parsed { key: string; ctrl: boolean; shift: boolean; alt: boolean }

function parse(s: string): Parsed {
  const parts = s.split('+')
  const key = parts[parts.length - 1]
  return {
    key: key.length === 1 ? key.toUpperCase() : key,
    ctrl: parts.includes('Ctrl'),
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt'),
  }
}

/** Installs the global keydown dispatcher. Returns an uninstall function. */
export function installShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    if (typing && e.key !== 'Escape') return
    if (typing) return
    const ctrl = e.ctrlKey || e.metaKey
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
    const sketch = useUi.getState().sketchMode
    let hit: Command | undefined
    for (const c of allCommands()) {
      if (!c.shortcut) continue
      if (c.category === 'Sketch' && !sketch) continue
      const p = parse(c.shortcut)
      if (p.key === key && p.ctrl === ctrl && p.shift === e.shiftKey && p.alt === e.altKey) {
        hit = c
        break
      }
    }
    if (!hit) return
    e.preventDefault()
    runCommand(hit.id)
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
