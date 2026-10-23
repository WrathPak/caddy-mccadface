import * as D from '@radix-ui/react-dropdown-menu'
import { CaretDown, Moon, Sun } from '@phosphor-icons/react'
import { RIBBON_TABS, type RibbonItem } from '@/app/ribbon'
import { getCommand, runCommand } from '@/app/commands'
import { useUi } from '@/store/ui'
import { Tip } from './Tooltip'

function Btn({ id, small }: { id: string; small?: boolean }) {
  const c = getCommand(id)
  const active = useUi((s) => s.activeTool === id)
  if (!c) return null
  return (
    <Tip label={c.label} shortcut={c.shortcut}>
      <button type="button" className={'rbtn' + (small ? ' small' : '')} data-active={active} onClick={() => runCommand(id)}>
        <c.icon size={small ? 14 : 24} weight="light" />
        <span className="lbl">{c.label.split(' / ')[0].replace('Create ', '')}</span>
      </button>
    </Tip>
  )
}

function Large({ item }: { item: RibbonItem }) {
  const c = getCommand(item.cmd!)
  const active = useUi((s) => s.activeTool === item.cmd)
  if (!c) return null
  if (!item.menu) return <Btn id={item.cmd!} />
  return (
    <D.Root>
      <Tip label={c.label} shortcut={c.shortcut}>
        <button type="button" className="rbtn" data-active={active} onClick={() => runCommand(item.cmd!)}>
          <c.icon size={24} weight="light" />
          <D.Trigger asChild>
            <span className="lbl" onClick={(e) => e.stopPropagation()} style={{ cursor: 'default' }}>
              {c.label.replace('Create ', '').split(' / ')[0]}
              <CaretDown size={8} weight="bold" className="rcaret" />
            </span>
          </D.Trigger>
        </button>
      </Tip>
      <D.Portal>
        <D.Content className="menu" sideOffset={2} align="start">
          {item.menu.map((m) => {
            const mc = getCommand(m)
            return mc ? (
              <D.Item key={m} className="menu-item" onSelect={() => runCommand(m)}>
                <mc.icon size={14} /> {mc.label}
                {mc.shortcut && <span className="kbd">{mc.shortcut}</span>}
              </D.Item>
            ) : null
          })}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

export function Ribbon() {
  const workspace = useUi((s) => s.workspace)
  const sketchMode = useUi((s) => s.sketchMode)
  const theme = useUi((s) => s.theme)
  const toggleTheme = useUi((s) => s.toggleTheme)
  const setWorkspace = useUi((s) => s.setWorkspace)
  const selected = sketchMode ? 'sketch' : workspace
  const tab = RIBBON_TABS.find((t) => t.id === selected)!

  return (
    <div className="ribbon">
      <div className="ribbon-tabs" role="tablist">
        {RIBBON_TABS.filter((t) => !t.contextual || sketchMode).map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === selected}
            disabled={t.disabled}
            className={'ribbon-tab' + (t.contextual ? ' sketch' : '')}
            onClick={() => !t.contextual && setWorkspace(t.id as 'solid')}
          >
            {t.label}
            {t.disabled && <span className="later">later</span>}
          </button>
        ))}
        <div className="ribbon-spacer" />
        <div className="ribbon-right">
          <Tip label="Toggle theme" side="bottom">
            <button type="button" className="rbtn small" style={{ minWidth: 0, padding: '1px 5px' }} onClick={toggleTheme}>
              {theme === 'dark' ? <Moon size={13} /> : <Sun size={13} />}
            </button>
          </Tip>
        </div>
      </div>
      <div className="ribbon-body">
        {tab.groups.map((g) => (
          <div className="rgroup" key={g.label}>
            <div className="rgroup-tools">
              {g.items.map((it, i) =>
                it.stack ? (
                  <div className="rstack" key={i}>
                    {it.stack.map((id) => <Btn key={id} id={id} small />)}
                  </div>
                ) : (
                  <Large key={i} item={it} />
                ),
              )}
            </div>
            <div className="rgroup-label">{g.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
