import * as D from '@radix-ui/react-dropdown-menu'
import { CaretDown, Moon, SidebarSimple, Sun } from '@phosphor-icons/react'
import { useMemo } from 'react'
import { RIBBON_TABS, type RibbonGroup, type RibbonItem } from '@/app/ribbon'
import { useRibbonExtras, withExtras } from '@/app/ribbonExtras'
import { getCommand, runCommand } from '@/app/commands'
import { useUi } from '@/store/ui'
import { guideById } from '@/help/guides'
import { useSettings } from '@/settings/settings'
import { HelpMenu } from '@/help/HelpMenu'
import { CmdTip, Tip } from './Tooltip'

export function Btn({ id, small }: { id: string; small?: boolean }) {
  const c = getCommand(id)
  const active = useUi((s) => s.activeTool === id)
  if (!c) return null
  return (
    <CmdTip cmd={c}>
      <button type="button" className={'rbtn' + (small ? ' small' : '')} data-active={active} onClick={() => runCommand(id)}>
        <c.icon size={small ? 14 : 24} weight="light" />
        <span className="lbl">{c.label.split(' / ')[0].replace('Create ', '')}</span>
      </button>
    </CmdTip>
  )
}

function Large({ item }: { item: RibbonItem }) {
  const c = getCommand(item.cmd!)
  const active = useUi((s) => s.activeTool === item.cmd)
  if (!c) return null
  if (!item.menu) return <Btn id={item.cmd!} />
  const lbl = c.label.replace('Create ', '').split(' / ')[0]
  return (
    <D.Root>
      <div className="rsplit" data-active={active}>
        <CmdTip cmd={c}>
          <button type="button" className="rbtn main" data-active={active} onClick={() => runCommand(item.cmd!)}>
            <c.icon size={24} weight="light" />
            <span className="lbl">{lbl}</span>
          </button>
        </CmdTip>
        <Tip label={`${lbl} options`} desc={`More choices for ${lbl.toLowerCase()}: ${item.menu.map((m) => getCommand(m)?.label).filter(Boolean).join(', ')}.`}>
          <D.Trigger asChild>
            <button type="button" className="rbtn caret" aria-label={`${lbl} options`}>
              <CaretDown size={9} weight="bold" className="rcaret" />
            </button>
          </D.Trigger>
        </Tip>
      </div>
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

/** The dockable panels (History, Projects, Plugins, Script): one compact menu at the right of the tab strip. */
export const PANEL_ITEMS = ['view.projects', 'view.history', 'view.plugins', 'view.script']

export function PanelsMenu() {
  return (
    <D.Root>
      <Tip label="Panels" desc="Open History, Projects, Plugins or the Script editor as panels beside the Browser." side="bottom">
        <D.Trigger asChild>
          <button type="button" className="rbtn small" aria-label="Panels" style={{ minWidth: 0, padding: '1px 5px' }}>
            <SidebarSimple size={13} />
          </button>
        </D.Trigger>
      </Tip>
      <D.Portal>
        <D.Content className="menu" sideOffset={2} align="end">
          {PANEL_ITEMS.map((id) => {
            const c = getCommand(id)
            return c ? (
              <D.Item key={id} className="menu-item" onSelect={() => runCommand(id)}>
                <c.icon size={14} /> {c.label}
              </D.Item>
            ) : null
          })}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

export const FILE_ITEMS = ['file.new', 'file.open', 'file.save', 'file.saveNote', 'file.saveAs', '-', 'file.import', 'file.export']

export function FileMenu() {
  return (
    <D.Root>
      <Tip label="File" desc="New, open, save, import and export. Your files stay on your computer." side="bottom">
        <D.Trigger asChild>
          <button type="button" className="ribbon-tab" style={{ marginRight: 4, color: 'var(--accent)' }}>File</button>
        </D.Trigger>
      </Tip>
      <D.Portal>
        <D.Content className="menu" sideOffset={2} align="start">
          {FILE_ITEMS.map((id, i) => {
            if (id === '-') return <D.Separator key={i} className="menu-sep" />
            const c = getCommand(id)
            return c ? (
              <D.Item key={id} className="menu-item" onSelect={() => runCommand(id)}>
                <c.icon size={14} /> {c.label}
                {c.shortcut && <span className="kbd">{c.shortcut}</span>}
              </D.Item>
            ) : null
          })}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

/** The groups of tool buttons of one tab (also the phone layout's scrolling tool strip). */
export function RibbonGroups({ groups }: { groups: RibbonGroup[] }) {
  return (
    <div className="ribbon-body">
      {groups.map((g) => (
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
  )
}

/** The tab (workspace) the ribbon shows right now, and the groups it lists. */
export function useRibbonTab() {
  const workspace = useUi((s) => s.workspace)
  const sketchMode = useUi((s) => s.sketchMode)
  const selected = sketchMode ? 'sketch' : workspace
  const tab = RIBBON_TABS.find((t) => t.id === selected)!
  const extras = useRibbonExtras((s) => s.items)
  const groups = useMemo(() => withExtras(tab, extras), [tab, extras])
  return { selected, tab, groups }
}

export function Ribbon() {
  const sketchMode = useUi((s) => s.sketchMode)
  const theme = useUi((s) => s.theme)
  const toggleTheme = useSettings((s) => s.toggleTheme)
  const setWorkspace = useUi((s) => s.setWorkspace)
  const { selected, groups } = useRibbonTab()

  return (
    <div className="ribbon">
      <div className="ribbon-tabs" role="tablist">
        <FileMenu />
        {RIBBON_TABS.filter((t) => !t.contextual || sketchMode).map((t) => (
          <Tip key={t.id} label={t.label} desc={guideById(t.id)?.summary} side="bottom">
            <button
              role="tab"
              aria-selected={t.id === selected}
              disabled={t.disabled}
              className={'ribbon-tab' + (t.contextual ? ' sketch' : '')}
              onClick={() => !t.contextual && setWorkspace(t.id as 'solid')}
            >
              {t.label}
              {t.disabled && <span className="later">later</span>}
            </button>
          </Tip>
        ))}
        <div className="ribbon-spacer" />
        <div className="ribbon-right">
          <PanelsMenu />
          <Tip label="Theme" desc={theme === 'dark' ? 'Switch to the light look.' : 'Switch to the dark look.'} side="bottom">
            <button type="button" className="rbtn small" aria-label="Toggle theme" data-testid="theme-toggle" style={{ minWidth: 0, padding: '1px 5px' }} onClick={toggleTheme}>
              {theme === 'dark' ? <Moon size={13} /> : <Sun size={13} />}
            </button>
          </Tip>
          <HelpMenu />
        </div>
      </div>
      <RibbonGroups groups={groups} />
    </div>
  )
}
