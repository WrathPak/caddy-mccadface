import { useEffect, useMemo, useRef, useState } from 'react'
import { allCommands, type Command } from '@/app/commands'
import { NAV_PRESETS, useNavSettings } from '@/viewport/navSettings'
import { SplitDialog, type NavItem } from '@/ui/SplitDialog'
import { ABOUT, GETTING_STARTED, type InfoSection } from './gettingStarted'
import { GUIDES, guideById } from './guides'
import { useHelp } from './helpStore'

function Info({ sections }: { sections: InfoSection[] }) {
  return (
    <>
      {sections.map((s) => (
        <section key={s.title} className="hp-sec">
          <h3>{s.title}</h3>
          {s.paragraphs?.map((p, i) => <p key={i}>{p}</p>)}
          {s.steps && <ol>{s.steps.map((t, i) => <li key={i}>{t}</li>)}</ol>}
          {s.rows && (
            <dl className="hp-rows">
              {s.rows.map(([k, v]) => (
                <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
          )}
        </section>
      ))}
    </>
  )
}

function GuidePage({ id, section }: { id: string; section?: string }) {
  const guide = guideById(id) ?? GUIDES[0]
  const pane = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = section ? pane.current?.querySelector<HTMLElement>(`[data-section="${section}"]`) : null
    if (el) el.scrollIntoView({ block: 'start' })
    else pane.current?.parentElement?.scrollTo?.({ top: 0 })
  }, [id, section])
  return (
    <div ref={pane} data-testid="guide-page" data-guide={guide.id}>
      <h2 className="hp-h2">{guide.title}</h2>
      <p className="hp-lead">{guide.summary}</p>
      {guide.sections.map((s) => (
        <section key={s.id} className="hp-sec" data-section={s.id} data-highlight={s.id === section}>
          <h3>{s.title}</h3>
          {s.intro && <p>{s.intro}</p>}
          <ol>{s.steps.map((t, i) => <li key={i}>{t}</li>)}</ol>
          {s.note && <p className="hp-note">{s.note}</p>}
        </section>
      ))}
    </div>
  )
}

/** Commands with a shortcut, grouped by category, straight from the registry so the list never drifts from the real keys. */
export function shortcutRows(cmds: Command[]): { category: string; rows: { label: string; keys: string }[] }[] {
  const seen = new Set<string>()
  const groups = new Map<string, { label: string; keys: string }[]>()
  for (const c of cmds) {
    if (!c.shortcut) continue
    const sig = c.label + '|' + c.shortcut
    if (seen.has(sig)) continue
    seen.add(sig)
    const cat = c.category === 'Sketch' ? 'Sketch (while sketching)' : c.category
    groups.set(cat, [...(groups.get(cat) ?? []), { label: c.id === 'edit.accept' ? 'Accept / finish' : c.label, keys: c.shortcut }])
  }
  return [...groups.entries()].map(([category, rows]) => ({ category, rows }))
}

function ShortcutsPage() {
  const [q, setQ] = useState('')
  const preset = useNavSettings((s) => s.preset)
  const nav = NAV_PRESETS.find((p) => p.id === preset)!
  const groups = useMemo(() => shortcutRows(allCommands()), [])
  const f = q.trim().toLowerCase()
  const match = (label: string, keys: string) => !f || label.toLowerCase().includes(f) || keys.toLowerCase().includes(f)
  const extras: { label: string; keys: string }[] = [
    { label: 'Rename the selected item in the Browser', keys: 'F2' },
    { label: 'Switch a timeline step off or on (chip focused)', keys: 'U' },
    { label: 'Edit a timeline step (chip focused)', keys: 'Enter' },
    { label: 'Hair and Print paint: change brush size', keys: '[  ]' },
    { label: 'Hair and Print paint: erase while painting', keys: 'Shift' },
    { label: 'Fit everything in the view', keys: 'Double-click middle button' },
  ]
  return (
    <div data-testid="shortcuts-page">
      <h2 className="hp-h2">Keyboard shortcuts</h2>
      <p className="hp-lead">Generated from the commands in the app. Sketch shortcuts only work while a sketch is open.</p>
      <input className="hp-search" placeholder="Filter shortcuts..." aria-label="Filter shortcuts" value={q} onChange={(e) => setQ(e.target.value)} />
      {groups.map((g) => {
        const rows = g.rows.filter((r) => match(r.label, r.keys))
        return rows.length ? (
          <section key={g.category} className="hp-sec" data-testid={'shortcuts-' + g.category.split(' ')[0].toLowerCase()}>
            <h3>{g.category}</h3>
            <dl className="hp-keys">{rows.map((r) => <div key={r.label + r.keys} data-testid="shortcut-row"><dt>{r.label}</dt><dd className="kbd">{r.keys}</dd></div>)}</dl>
          </section>
        ) : null
      })}
      <section className="hp-sec">
        <h3>Mouse and other keys</h3>
        <p>Mouse style: {nav.label}. {nav.help} Change it in Settings, under Navigation.</p>
        <dl className="hp-keys">{extras.filter((r) => match(r.label, r.keys)).map((r) => <div key={r.label}><dt>{r.label}</dt><dd className="kbd">{r.keys}</dd></div>)}</dl>
      </section>
    </div>
  )
}

const NAV: NavItem[] = [
  { id: 'start', label: 'Getting started' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { heading: 'Workspace guides' },
  ...GUIDES.map((g) => ({ id: 'guide:' + g.id, label: g.title })),
  { heading: 'About' },
  { id: 'about', label: 'About' },
]

/** Help dialog: Getting started, Keyboard shortcuts, one guide per workspace and About. */
export function HelpDialog() {
  const { open, page, show, close } = useHelp()
  const active = page.kind === 'guide' ? 'guide:' + page.id : page.kind
  const select = (id: string) => {
    if (id.startsWith('guide:')) show({ kind: 'guide', id: id.slice(6) })
    else show({ kind: id as 'start' | 'shortcuts' | 'about' })
  }
  return (
    <SplitDialog open={open} onOpenChange={(o) => !o && close()} title="Help" description="Guides, shortcuts and an overview of the app." nav={NAV} active={active} onSelect={select} testId="help-dialog">
      {page.kind === 'start' && <div data-testid="start-page"><h2 className="hp-h2">Getting started</h2><Info sections={GETTING_STARTED} /></div>}
      {page.kind === 'shortcuts' && <ShortcutsPage />}
      {page.kind === 'guide' && <GuidePage id={page.id} section={page.section} />}
      {page.kind === 'about' && <div data-testid="about-page"><h2 className="hp-h2">About</h2><Info sections={ABOUT} /></div>}
    </SplitDialog>
  )
}
