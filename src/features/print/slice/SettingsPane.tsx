/** Renders a settings document from the engine (Orca's pages, groups and rows) as the panel's pages and rows. */
import { useMemo } from 'react'
import type { ConfigPatch, FormLine, FormOption, SettingsView, ViewLine, ViewPage } from '@muon3d/slicer-engine-protocol'
import { Checkbox } from '@/ui/Toggle'
import { Tip } from '@/ui/Tooltip'
import { Cell, ModifiedMark } from './fields'

export interface PaneProps {
  view: SettingsView
  overrides: ConfigPatch
  search: string
  page: string
  onPage: (id: string) => void
  onEdit: (key: string, text: string, index?: number) => void
  onReset: (key: string) => void
}

const plain = (s: string) => s.toLowerCase()

/** Row: label with its tooltip, a control per cell, and the modified mark. */
function RowView({ line, form, opts, overrides, onEdit, onReset }: { line: ViewLine; form: FormLine | undefined; opts: Record<string, FormOption>; overrides: ConfigPatch; onEdit: PaneProps['onEdit']; onReset: PaneProps['onReset'] }) {
  const first = opts[line.cells[0]?.key]
  const label = line.label ?? form?.label ?? first?.label ?? line.cells[0]?.key ?? ''
  const tip = form?.tooltip ?? first?.tooltip
  const keys = [...new Set(line.cells.map((c) => c.key))]
  const modified = keys.filter((k) => k in overrides)
  const override = form?.overrideOf
  return (
    <div className="sl-row" data-testid={`row-${keys[0]}`} data-modified={modified.length > 0} data-key={keys[0]}>
      <ModifiedMark modified={modified.length > 0} label={label} onReset={() => modified.forEach(onReset)} />
      <Tip label={label} desc={tip} side="top"><span className="sl-label">{label}</span></Tip>
      <div className="sl-cells">
        {line.cells.map((c, i) => {
          const opt = opts[c.key]
          if (!opt) return null
          const sub = line.cells.length > 1 ? (c.label ?? form?.options[i]?.label) : undefined
          const off = override && c.value === 'nil'
          return (
            <span className="sl-cell" key={`${c.key}-${c.index ?? ''}-${i}`}>
              {sub && <span className="sl-sub">{sub}</span>}
              {override && (
                <Checkbox
                  checked={!off} ariaLabel={`Override ${opt.label}`}
                  onChange={(v) => !line.locked && onEdit(c.key, v ? (c.inherited && c.inherited !== 'nil' ? c.inherited : '0') : 'nil', c.index)}
                />
              )}
              <Cell opt={opt} cell={c} disabled={off || undefined} onEdit={(t, ix) => onEdit(c.key, t, ix ?? c.index)} />
            </span>
          )
        })}
      </div>
    </div>
  )
}

export function SettingsPane(p: PaneProps) {
  const { view, overrides, search, page, onPage, onEdit, onReset } = p
  const form = view.form
  const pages = view.tab?.pages ?? []
  const lines = useMemo(() => {
    const m = new Map<string, FormLine>()
    form?.pages?.forEach((pg) => pg.groups.forEach((g) => g.lines.forEach((l) => m.set(l.id, l))))
    return m
  }, [form])
  const groupTitle = (pg: ViewPage, gid: string) => form?.pages?.find((x) => x.id === pg.page)?.groups.find((g) => g.id === gid)?.title ?? ''
  if (!form) return null
  const cur = pages.find((x) => x.id === page) ?? pages[0]
  const q = plain(search.trim())
  const match = (l: ViewLine) => {
    const f = lines.get(l.id)
    const keys = l.cells.map((c) => c.key)
    const hay = plain([l.label, f?.label, ...keys, ...keys.map((k) => form.options[k]?.label), f?.tooltip].filter(Boolean).join(' '))
    return hay.includes(q)
  }
  const row = (l: ViewLine) => <RowView key={l.id} line={l} form={lines.get(l.id)} opts={form.options} overrides={overrides} onEdit={onEdit} onReset={onReset} />

  return (
    <div className="sl-pane">
      <nav className="sl-nav" aria-label="Settings pages">
        {pages.map((pg) => (
          <button key={pg.id} type="button" className="sl-navitem" data-active={!q && cur?.id === pg.id} data-testid={`page-${pg.page}`} onClick={() => onPage(pg.id)}>
            <span>{pg.title}</span>
            {!!pg.issues && <span className="sl-badge" title="Warnings on this page">{pg.issues}</span>}
          </button>
        ))}
      </nav>
      <div className="sl-page" data-testid="settings-page">
        {q ? (
          <>
            {pages.map((pg) => {
              const found = pg.groups.flatMap((g) => g.lines.filter(match).map((l) => ({ g, l })))
              if (!found.length) return null
              return (
                <section className="sl-group" key={pg.id}>
                  <h4>{pg.title}</h4>
                  {found.map(({ l }) => row(l))}
                </section>
              )
            })}
            {!pages.some((pg) => pg.groups.some((g) => g.lines.some(match))) && <p className="sl-empty">No setting matches "{search}".</p>}
          </>
        ) : (
          cur?.groups.map((g) => (
            <section className="sl-group" key={g.id}>
              <h4>{groupTitle(cur, g.id)}</h4>
              {g.lines.map(row)}
            </section>
          ))
        )}
      </div>
    </div>
  )
}
