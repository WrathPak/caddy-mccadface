import { useEffect, useRef, useState } from 'react'
import { Crosshair, X } from '@phosphor-icons/react'
import { useUi, type InspectorSession, type SelectionRef } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { evalNumber, resolveParams } from '@/doc/params'
import { bodyIdsOf, encodeSelection } from '@/doc/refs'
import { NumberField } from './NumberField'
import { Select } from './Select'
import { Checkbox } from './Toggle'
import { Segmented } from './Segmented'
import { Section } from './Section'
import { missingRequired, schemaDefaults, selectionParams, type ParamDef, type ParamValue, type ParamValues, type SelectionRefParam } from './schema'

type Setter = (key: string, v: ParamValue) => void
interface Pick { active: string | null; activate: (key: string) => void }

function Param({ def, values, set, pick }: { def: ParamDef; values: ParamValues; set: Setter; pick: Pick }) {
  if (def.type === 'group') {
    return (
      <Section title={def.label} defaultOpen={!def.collapsed}>
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
        <NumberField label={def.label} value={typeof v === 'string' ? (evalNumber(v, def.unit) ?? 0) : (v as number)} expr={typeof v === 'string' ? v : undefined} unit={def.unit} min={def.min} max={def.max} step={def.step}
          onChange={(n, ex) => set(def.key, ex ?? n)} />
      )
    case 'enum':
      return def.display === 'segmented' ? (
        <Segmented label={def.label} value={v as string} options={def.options} onChange={(s) => set(def.key, s)} />
      ) : (
        <Select label={def.label} value={v as string} options={def.options} onChange={(s) => set(def.key, s)} />
      )
    case 'bool':
      return <Checkbox label={def.label} checked={v as boolean} onChange={(b) => set(def.key, b)} />
    case 'vector3': {
      const vec: number[] = Array.isArray(v) && v.length === 3 ? (v as number[]) : [0, 0, 0]
      return (
        <div className="field stack">
          <span className="field-label" title={def.label}>{def.label}{def.unit ? ` (${def.unit})` : ''}</span>
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
  const { label, accepts } = def
  const empty = value.length === 0
  return (
    <div className="field" data-sel-key={def.key} data-active={active} data-empty={empty}>
      <span className="field-label" title={label}>{label}{def.required ? ' *' : ''}</span>
      <div className={'inp sel-ref' + (active ? ' active' : '')} data-testid={'sel-' + def.key} style={{ borderColor: active || empty ? 'var(--accent-line)' : undefined, cursor: def.pick ? 'pointer' : undefined }} onClick={onActivate}>
        <span className="txt" title={empty ? undefined : `${value.length} selected`} style={{ color: empty ? 'var(--text-faint)' : 'var(--text)' }}>
          {empty ? `Select ${accepts.join(' / ')}` : `${value.length} selected`}
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

const KIND_OF: Record<string, string> = { body: 'body', mesh: 'body', face: 'face', edge: 'edge', sketch: 'sketch' }

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
    useUi.setState({ pickSketches: !!d?.accepts.includes('sketch') })
    const f = d?.accepts.find((k) => k === 'body' || k === 'face' || k === 'edge')
    if (f) { touchedFilter.current = true; useUi.getState().setSelectionFilter(f) }
  }
  // the active field is the first empty pick field (or the first one)
  useEffect(() => {
    const ps = picks()
    if (ps.length && !activeRef.current) activate((ps.find((p) => !(latest.current[p.key] as string[])?.length) ?? ps[0]).key)
    const restore = prevFilter.current
    return () => {
      useUi.setState({ pickSketches: false })
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
  const missing = missingRequired(session.schema, values)
  let invalid: string | null = null
  try { resolveParams(session.schema, values) } catch (e) { invalid = e instanceof Error ? e.message : String(e) }
  const blocked = missing.length > 0 || invalid !== null
  const hint = missing.length ? `Select ${missing.map((m) => m.toLowerCase()).join(' and ')} to continue` : (invalid ?? '')
  return (
    <div className="panel">
      <div className="panel-title">{session.schema.title}</div>
      <div className="panel-scroll">
        <div className="section-body">
          {session.schema.params.filter((p) => p.type !== 'group').map((p, i) => (
            <Param key={i} def={p} values={values} set={set} pick={{ active, activate }} />
          ))}
        </div>
        {session.schema.params.filter((p) => p.type === 'group').map((p, i) => (
          <Param key={i} def={p} values={values} set={set} pick={{ active, activate }} />
        ))}
      </div>
      {blocked && <div className="inspector-hint" role="status" data-testid="inspector-hint">{hint}</div>}
      <div className="inspector-foot">
        <button type="button" className="btn" onClick={session.onCancel}>Cancel</button>
        <button type="button" className="btn primary" disabled={blocked} title={blocked ? hint : undefined} onClick={() => !blocked && session.onOk(latest.current)}>OK</button>
      </div>
    </div>
  )
}
