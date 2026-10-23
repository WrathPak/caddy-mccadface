import { Command } from 'cmdk'
import { useMemo } from 'react'
import { allCommands, runCommand, type Command as Cmd } from '@/app/commands'
import { useUi } from '@/store/ui'

/** Opened with `S`. Lists every registered command. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  const setOpen = useUi((s) => s.setPaletteOpen)
  const groups = useMemo(() => {
    const m = new Map<string, Cmd[]>()
    for (const c of allCommands()) m.set(c.category, [...(m.get(c.category) ?? []), c])
    return [...m.entries()]
  }, [open])
  if (!open) return null
  return (
    <div className="cmdk-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <Command className="cmdk" label="Command palette" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
        <Command.Input autoFocus placeholder="Search commands..." />
        <Command.List>
          <Command.Empty>No matching command</Command.Empty>
          {groups.map(([cat, cmds]) => (
            <Command.Group key={cat} heading={cat}>
              {cmds.map((c) => (
                <Command.Item key={c.id} value={`${c.label} ${c.id}`} onSelect={() => { setOpen(false); runCommand(c.id) }}>
                  <c.icon size={14} />
                  <span>{c.label}</span>
                  {c.shortcut && <span className="kbd">{c.shortcut}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </div>
  )
}
