import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Crosshair, X } from '@phosphor-icons/react'
import { useUi, type InspectorSession, type SelectionRef } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { evalNumber, resolveParams } from '@/doc/params'
import { bodyIdsOf, decodeRef, encodeRef, encodeSelection } from '@/doc/refs'
import { NumberField } from './NumberField'
import { Select } from './Select'
import { Checkbox } from './Toggle'
import { Segmented } from './Segmented'
import { NUDGE_EVENT } from './accept'
import { OptionList } from './OptionList'
import { Section } from './Section'
import { missingRequired, schemaDefaults, selectionParams, type ParamDef, type ParamValue, type ParamValues, type SelectionRefParam } from './schema'

/** Stored refs of the feature being edited that the last regeneration re-bound by position / could not resolve. */
interface RefFlags { rebound: Set<string>; lost: Set<string> }
const RefFlagsCtx = createContext<RefFlags>({ rebound: new Set(), lost: new Set() })
const normRef = (s: string) => {
  try { const r = s.startsWith('{') ? decodeRef(s) : null; return r ? encodeRef(r) : s } catch { return s }
}

type Setter = (key: string, v: ParamValue) => void
interface Pick { active: string | null; activate: (key: string) => void; many: (v: ParamValues) => void; group: (id: string) => void }

/** Shows the field's help line under it while any control inside has the keyboard focus. */
function Hinted({ help, children }: { help?: string; children: ReactNode }) {
  const [focus, setFocus] = useState(false)
  if (!help) return <>{children}</>
  return (
    <div className="hinted" onFocusCapture={() => setFocus(true)} onBlurCapture={() => setFocus(false)}>
      {children}
      {focus && <div className="field-hint" data-testid="field-hint">{help}</div>}
    </div>
  )
}

function Param(props: { def: ParamDef; values: ParamValues; set: Setter; pick: Pick }) {
  const { def } = props
  if (def.type === 'group') return <ParamInner {...props} />
  if (def.visibleWhen && !def.visibleWhen(props.values)) return null
  return <Hinted help={def.help}><ParamInner {...props} /></Hinted>
}

function ParamInner({ def, values, set, pick }: { def: ParamDef; values: ParamValues; set: Setter; pick: Pick }) {
  if (def.type === 'group') {
    return (
      <Section title={def.label} defaultOpen={!def.collapsed} help={def.help} onActive={def.id ? () => pick.group(def.id!) : undefined}>
        {def.children.map((c, i) => (
          <Param key={i} def={c} values={values} set={set} pick={pick} />
        ))}
      </Section>
    )
  }
  if (def.visibleWhen && !def.visibleWhen(values)) return null
  const v = values[def.key]
  switch (def.type) {
    case 'number':
      return (
        <NumberField label={def.label} help={def.help} value={typeof v === 'string' ? (evalNumber(v, def.unit) ?? 0) : (v as number)} expr={typeof v === 'string' ? v : undefined} unit={def.unit} min={def.min} max={def.max} step={def.step}
          onChange={(n, ex) => set(def.key, ex ?? n)} />
      )
    case 'enum':
      if (def.display === 'list') return <OptionList label={def.label} value={def.aliases?.[v as string] ?? (v as string)} options={def.options} onChange={(s) => set(def.key, s)} />
      return def.display === 'segmented' ? (
        <Segmented label={def.label} help={def.help} value={v as string} options={def.options} onChange={(s) => set(def.key, s)} />
      ) : (
        <Select label={def.label} help={def.help} value={v as string} options={def.options} onChange={(s) => set(def.key, s)} />
      )
    case 'preset':
      return (
        <Select label={def.label} help={def.help} placeholder="Choose a preset" value={v as string} options={def.presets.map((p) => ({ value: p.id, label: p.label }))}
          onChange={(id) => { const p = def.presets.find((x) => x.id === id); if (p) pick.many({ ...p.values, [def.key]: id }) }} />
      )
    case 'bool':
      return <Checkbox label={def.label} help={def.help} checked={v as boolean} onChange={(b) => set(def.key, b)} />
    case 'vector3': {
      const vec: number[] = Array.isArray(v) && v.length === 3 ? (v as number[]) : [0, 0, 0]
      return (
        <div className="field stack">
          <span className="field-label" title={def.help ?? def.label}>{def.label}{def.unit ? ` (${def.unit})` : ''}</span>
          <div className="vec3">
            {(['X', 'Y', 'Z'] as const).map((ax, i) => (
              <NumberField key={ax} value={vec[i]} step={def.step}
                prefix={<span className={'mono axis-' + ax.toLowerCase()} style={{ marginRight: 4 }}>{ax}</span>}
                onChange={(n) => { const c = [...vec] as [number, number, number]; c[i] = n; set(def.key, c) }} />
            ))}
          </div>
        </div>
      )
    }
    case 'info':
      return (
        <div className="field stack" data-testid={'info-' + def.key}>
          <span className="field-label" title={def.label}>{def.label}</span>
          <div className="info-text">{def.text(values)}</div>
        </div>
      )
    case 'selection-ref':
      return <SelectionRef def={def} value={Array.isArray(v) ? (v as string[]) : []} onChange={(s) => set(def.key, s)} active={pick.active === def.key} onActivate={() => def.pick && pick.activate(def.key)} />
  }
}

function SelectionRef({ def, value, onChange, active, onActivate }: { def: SelectionRefParam; value: string[]; onChange: (s: string[]) => void; active: boolean; onActivate: () => void }) {
  const sel = useUi((s) => s.selection)
  const flags = useContext(RefFlagsCtx)
  const { label, accepts } = def
  const empty = value.length === 0
  const lost = value.filter((x) => flags.lost.has(normRef(x))).length
  const rebound = lost ? 0 : value.filter((x) => flags.rebound.has(normRef(x))).length
  const flag = lost ? 'lost' : rebound ? 'rebound' : undefined
  const note = lost
    ? `${lost} of ${value.length} no longer exist${lost === 1 ? 's' : ''}: pick again`
    : rebound ? `${rebound} of ${value.length} re-bound by position: check ${rebound === 1 ? 'it' : 'them'}` : undefined
  const flagColor = flag === 'lost' ? 'var(--danger, #e06060)' : '#e0b050'
  return (
    <div className="field" data-sel-key={def.key} data-active={active} data-empty={empty} data-ref-flag={flag}>
      <span className="field-label" title={def.help ?? label}>{label}{def.required ? ' *' : ''}</span>
      <div className={'inp sel-ref' + (active ? ' active' : '')} data-testid={'sel-' + def.key} style={{ borderColor: flag ? flagColor : active || empty ? 'var(--accent-line)' : undefined, cursor: def.pick ? 'pointer' : undefined }} onClick={onActivate}>
        <span className="txt" title={note ?? (empty ? undefined : `${value.length} selected`)} style={{ color: flag ? flagColor : empty ? 'var(--text-faint)' : 'var(--text)' }}>
          {empty ? `Select ${accepts.join(' / ')}` : note ? `${value.length} selected - ${note}` : `${value.length} selected`}
        </span>
        <button type="button" className="icon-btn" title="Use current selection" aria-label="Use selection" onClick={(e) => { e.stopPropagation(); onChange(encodeSelection(sel, useDoc.getState().geometry)) }}>
          <Crosshair size={12} />
        </button>
        {!empty && (
          <button type="button" className="icon-btn" title="Clear" aria-label="Clear" onClick={(e) => { e.stopPropagation(); onChange([]); onActivate() }}>
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

const KIND_OF: Record<string, string> = { body: 'body', mesh: 'body', face: 'face', edge: 'edge', sketch: 'sketch', plane: 'plane', axis: 'axis', point: 'point', vertex: 'vertex', feature: 'feature' }

/** Schema-driven feature dialog. Renders `ui.inspector` (any ParamSchema) with OK / Cancel. */
export function Inspector() {
  const session = useUi((s) => s.inspector)
  if (!session) return <div className="panel"><div className="panel-title">Inspector</div><div className="empty">Select a feature or start a tool to edit its parameters.</div></div>
  // a fresh form per session object: its initial state is the session's values (never an empty object)
  return <InspectorForm key={sessionKey(session)} session={session} />
}

const sessionIds = new WeakMap<object, number>()
let sessionSeq = 0
const sessionKey = (s: InspectorSession) => {
  let k = sessionIds.get(s)
  if (!k) sessionIds.set(s, (k = ++sessionSeq))
  return k
}

function InspectorForm({ session }: { session: InspectorSession }) {
  const [values, setValues] = useState<ParamValues>(() => ({ ...schemaDefaults(session.schema), ...session.values }))

  const latest = useRef(values)
  const [active, setActive] = useState<string | null>(null)
  const activeRef = useRef<string | null>(null)
  const prevFilter = useRef(useUi.getState().selectionFilter)
  const touchedFilter = useRef(false)
  const picks = () => selectionParams(session.schema, latest.current).filter((d) => d.pick)
  const activate = (key: string | null) => {
    activeRef.current = key
    setActive(key)
    const d = picks().find((p) => p.key === key)
    useUi.setState({ pickSketches: !!d?.accepts.includes('sketch'), pickKinds: (d?.accepts ?? []) as never })
    const f = d?.accepts.find((k) => k === 'body' || k === 'face' || k === 'edge')
    if (f) { touchedFilter.current = true; useUi.getState().setSelectionFilter(f) }
  }
  // the active field is the first empty pick field (or the first one)
  useEffect(() => {
    const ps = picks()
    if (ps.length && !activeRef.current) activate((ps.find((p) => !(latest.current[p.key] as string[])?.length) ?? ps[0]).key)
    const restore = prevFilter.current
    return () => {
      useUi.setState({ pickSketches: false, pickKinds: [] })
      if (touchedFilter.current) useUi.getState().setSelectionFilter(restore)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // viewport / Browser picks flow into the active field
  useEffect(() => {
    return useUi.subscribe((s, p) => {
      if (s.selection === p.selection) return
      const d = picks().find((x) => x.key === activeRef.current)
      if (!d) return
      const hits = s.selection.filter((r) => d.accepts.includes(KIND_OF[r.kind] as never))
      if (!hits.length) return
      const geometry = useDoc.getState().geometry
      let value: string[]
      if (d.multiple) {
        // multi fields accumulate picks: a newly picked entity is added, picking one that is already in the field removes it
        const old = (latest.current[d.key] as string[]) ?? []
        const isNew = (r: SelectionRef) => !p.selection.some((q) => q.kind === r.kind && q.id === r.id && q.index === r.index)
        let picked = hits.filter(isNew)
        if (!picked.length && hits.length === 1) picked = hits
        value = [...old]
        for (const enc of encodeSelection(picked, geometry)) {
          const same = (x: string) => x === enc || (d.accepts.includes('body') && bodyIdsOf([x])[0] === bodyIdsOf([enc])[0] && !x.startsWith('{'))
          const at = value.findIndex(same)
          if (at >= 0) value.splice(at, 1)
          else value.push(enc)
        }
      } else value = encodeSelection(hits.slice(-1), geometry)
      const next = { ...latest.current, [d.key]: value }
      latest.current = next
      setValues(next)
      session.onChange?.(next)
      if (!d.multiple) {
        const after = picks().find((x) => x.key !== d.key && !(next[x.key] as string[])?.length)
        if (after) activate(after.key)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const set: Setter = (key, v) => {
    const next = { ...latest.current, [key]: v }
    latest.current = next
    setValues(next)
    session.onChange?.(next)
  }
  const many = (vals: ParamValues) => {
    const next = { ...latest.current, ...vals }
    latest.current = next
    setValues(next)
    session.onChange?.(next)
  }
  const missing = missingRequired(session.schema, values)
  let invalid: string | null = null
  try { resolveParams(session.schema, values) } catch (e) { invalid = e instanceof Error ? e.message : String(e) }
  const blocked = missing.length > 0 || invalid !== null
  const hint = missing.length ? `Select ${missing.map((m) => m.toLowerCase()).join(' and ')} to continue` : (invalid ?? '')
  const warnings = session.schema.warnings ? session.schema.warnings(values) : []
  const notice = useUi((s) => s.inspectorNotice)

  // Enter accepts a valid dialog (an invalid one flashes its hint), Escape cancels. Keys typed into the command palette,
  // rename boxes, menus or other dialogs belong to those, not to the feature dialog.
  const [nudge, setNudge] = useState(0)
  const live = useRef({ blocked, session })
  live.current = { blocked, session }
  useEffect(() => {
    const flash = () => setNudge((n) => n + 1)
    window.addEventListener(NUDGE_EVENT, flash)
    return () => window.removeEventListener(NUDGE_EVENT, flash)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key !== 'Enter' && e.key !== 'Escape') return
      const t = e.target as HTMLElement | null
      if (t?.closest?.('.cmdk-overlay, [role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], .sk-dim-input, .rename')) return
      const inForm = !!t?.closest?.('[data-inspector-root], [data-accept-on-enter]')
      const editable = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (editable && !inForm) return
      if (e.key === 'Escape') {
        // buttons / the global shortcut handle Escape elsewhere; here only text boxes of this form, which the global handler skips
        if (editable && inForm) { e.preventDefault(); live.current.session.onCancel() }
        return
      }
      // controls of the dialog itself keep their own Enter; a focused ribbon / toolbar button must not swallow it
      if (!editable && inForm && t?.closest?.('button, a, [role="checkbox"], [role="radio"], [role="combobox"], [role="tab"], select')) return
      if (editable && (t as HTMLInputElement).type === 'checkbox') return
      e.preventDefault()
      if (live.current.blocked) setNudge((n) => n + 1)
      else live.current.session.onOk(latest.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const pickCtx: Pick = { active, activate, many, group: (id) => session.onActiveGroup?.(id) }
  const feat = useDoc((s) => (session.featureId ? s.features.find((f) => f.id === session.featureId) : undefined))
  const flags = useMemo<RefFlags>(
    () => ({ rebound: new Set((feat?.reboundRefs ?? []).map(normRef)), lost: new Set((feat?.lostRefs ?? []).map(normRef)) }),
    [feat?.reboundRefs, feat?.lostRefs],
  )
  const featureNote = feat && (feat.state === 'error' ? feat.error : feat.state === 'warning' ? feat.warning : undefined)
  return (
    <RefFlagsCtx.Provider value={flags}>
    <div className="panel" data-inspector-root>
      <div className="panel-title">{session.schema.title}</div>
      <div className="panel-scroll">
        <div className="section-body">
          {session.schema.params.filter((p) => p.type !== 'group').map((p, i) => (
            <Param key={i} def={p} values={values} set={set} pick={pickCtx} />
          ))}
        </div>
        {session.schema.params.filter((p) => p.type === 'group').map((p, i) => (
          <Param key={i} def={p} values={values} set={set} pick={pickCtx} />
        ))}
      </div>
      {notice && <div className="inspector-warn error" role="alert" data-testid="inspector-notice">{notice}</div>}
      {featureNote && <div className={'inspector-warn' + (feat?.state === 'error' ? ' error' : '')} role="note" data-testid="feature-note">{featureNote}</div>}
      {warnings.map((w, i) => <div key={i} className="inspector-warn" role="note" data-testid="inspector-warning">{w}</div>)}
      {blocked && <div key={nudge} className={'inspector-hint' + (nudge ? ' nudge' : '')} role="status" data-testid="inspector-hint">{hint}</div>}
      <div className="inspector-foot">
        <button type="button" className="btn" onClick={session.onCancel}>Cancel</button>
        <button type="button" className="btn primary" disabled={blocked} title={blocked ? hint : undefined} onClick={() => !blocked && session.onOk(latest.current)}>OK</button>
      </div>
    </div>
    </RefFlagsCtx.Provider>
  )
}
