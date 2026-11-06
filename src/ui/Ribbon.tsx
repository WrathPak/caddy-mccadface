import * as D from '@radix-ui/react-dropdown-menu'
import { CaretDown, CaretLeft, CaretRight, GithubLogo, Moon, SidebarSimple, Sun } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef } from 'react'
import { RIBBON_TABS, type RibbonGroup, type RibbonItem } from '@/app/ribbon'
import { useRibbonExtras, withExtras } from '@/app/ribbonExtras'
import { getCommand, runCommand } from '@/app/commands'
import { useUi } from '@/store/ui'
import { guideById } from '@/help/guides'
import { useSettings } from '@/settings/settings'
import { HelpMenu } from '@/help/HelpMenu'
import { CmdTip, Tip } from './Tooltip'
import { useThumb } from './useThumb'

export function Btn({ id, small }: { id: string; small?: boolean }) {
  const c = getCommand(id)
  const active = useUi((s) => s.activeTool === id)
  if (!c) return null
  return (
    <CmdTip cmd={c}>
      <button type="button" className={'rbtn' + (small ? ' small' : '')} data-active={active} onClick={() => runCommand(id)}>
        <c.icon size={small ? 16 : 22} weight="duotone" />
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
            <c.icon size={22} weight="duotone" />
            <span className="lbl">{lbl}</span>
          </button>
        </CmdTip>
        <Tip label={`${lbl} options`} desc={`More choices for ${lbl.toLowerCase()}: ${item.menu.map((m) => getCommand(m)?.label).filter(Boolean).join(', ')}.`}>
          <D.Trigger asChild>
            <button type="button" className="rbtn caret" aria-label={`${lbl} options`}>
              <CaretDown size={11} weight="bold" className="rcaret" />
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
                <mc.icon size={16} /> {mc.label}
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
          <button type="button" className="rbtn small" aria-label="Panels">
            <SidebarSimple size={16} />
          </button>
        </D.Trigger>
      </Tip>
      <D.Portal>
        <D.Content className="menu" sideOffset={2} align="end">
          {PANEL_ITEMS.map((id) => {
            const c = getCommand(id)
            return c ? (
              <D.Item key={id} className="menu-item" onSelect={() => runCommand(id)}>
                <c.icon size={16} /> {c.label}
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
          <button type="button" className="file-btn">File</button>
        </D.Trigger>
      </Tip>
      <D.Portal>
        <D.Content className="menu" sideOffset={2} align="start">
          {FILE_ITEMS.map((id, i) => {
            if (id === '-') return <D.Separator key={i} className="menu-sep" />
            const c = getCommand(id)
            return c ? (
              <D.Item key={id} className="menu-item" onSelect={() => runCommand(id)}>
                <c.icon size={16} /> {c.label}
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
  const ref = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  // a strip wider than the window scrolls: soft fades and two round arrows on the cut-off sides say so, and the wheel scrolls it sideways
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const mark = () => {
      const l = String(el.scrollLeft > 4), r = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
      for (const t of [el, wrap.current]) if (t) { t.dataset.fadeL = l; t.dataset.fadeR = r }
    }
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    mark()
    el.addEventListener('scroll', mark, { passive: true })
    el.addEventListener('wheel', wheel, { passive: false })
    const ro = new ResizeObserver(mark)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    const mo = new MutationObserver(mark)
    mo.observe(el, { childList: true, subtree: true })
    return () => { el.removeEventListener('scroll', mark); el.removeEventListener('wheel', wheel); ro.disconnect(); mo.disconnect() }
  }, [groups])
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * Math.max(240, (ref.current?.clientWidth ?? 600) * 0.6), behavior: 'smooth' })
  return (
    <div className="ribbon-wrap" ref={wrap}>
      <button type="button" className="ribbon-scroll l" aria-label="Scroll tools left" tabIndex={-1} onClick={() => scroll(-1)}><CaretLeft size={14} weight="bold" /></button>
      <div className="ribbon-body" ref={ref}>
        {groups.map((g) => (
          <div className="rgroup" key={g.label}>
            <div className="rgroup-tools">
              {g.items.map((it, i) =>
                it.stack ? (
                  // the File group is tiles like every other group; elsewhere a stack is a column of small buttons
                  g.label === 'File'
                    ? it.stack.map((id) => <Btn key={id} id={id} />)
                    : <div className="rstack" key={i}>{it.stack.map((id) => <Btn key={id} id={id} small />)}</div>
                ) : (
                  <Large key={i} item={it} />
                ),
              )}
            </div>
            <div className="rgroup-label">{g.label}</div>
          </div>
        ))}
      </div>
      <button type="button" className="ribbon-scroll r" aria-label="Scroll tools right" tabIndex={-1} onClick={() => scroll(1)}><CaretRight size={14} weight="bold" /></button>
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
  const seg = useRef<HTMLDivElement>(null)
  useThumb(seg, "[aria-selected='true']", selected + sketchMode)

  return (
    <div className="ribbon">
      <div className="ribbon-tabs" role="tablist">
        <FileMenu />
        <div className="ws-seg" ref={seg}>
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
        </div>
        <div className="ribbon-spacer" />
        <div className="ribbon-right">
          <PanelsMenu />
          <Tip label="Theme" desc={theme === 'dark' ? 'Switch to the light look.' : 'Switch to the dark look.'} side="bottom">
            <button type="button" className="rbtn small" aria-label="Toggle theme" data-testid="theme-toggle" onClick={toggleTheme}>
              {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
            </button>
          </Tip>
          <HelpMenu />
          <Tip label="GitHub" desc="The source code, and where to report a bug or ask for a feature. Opens in a new tab." side="bottom">
            <a className="rbtn small" href="https://github.com/WrathPak/caddy-mccadface" target="_blank" rel="noopener noreferrer" aria-label="GitHub" data-testid="github-link">
              <GithubLogo size={16} />
            </a>
          </Tip>
        </div>
      </div>
      <RibbonGroups groups={groups} />
    </div>
  )
}
