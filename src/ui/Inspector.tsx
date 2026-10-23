import { useRef, useState } from 'react'
import { Crosshair, X } from '@phosphor-icons/react'
import { useUi, type InspectorSession } from '@/store/ui'
import { useDoc } from '@/doc/store'
import { evalNumber } from '@/doc/params'
import { encodeSelection } from '@/doc/refs'
import { NumberField } from './NumberField'
import { Select } from './Select'
import { Checkbox } from './Toggle'
import { Segmented } from './Segmented'
import { Section } from './Section'
import { schemaDefaults, type ParamDef, type ParamValue, type ParamValues } from './schema'

type Setter = (key: string, v: ParamValue) => void

function Param({ def, values, set }: { def: ParamDef; values: ParamValues; set: Setter }) {
  if (def.type === 'group') {
    return (
      <Section title={def.label} defaultOpen={!def.collapsed}>
        {def.children.map((c, i) => (
          <Param key={i} def={c} values={values} set={set} />
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
    case 'selection-ref':
      return <SelectionRef label={def.label} accepts={def.accepts} value={Array.isArray(v) ? (v as string[]) : []} onChange={(s) => set(def.key, s)} />
  }
}

function SelectionRef({ label, accepts, value, onChange }: { label: string; accepts: string[]; value: string[]; onChange: (s: string[]) => void }) {
  const sel = useUi((s) => s.selection)
  return (
    <div className="field">
      <span className="field-label" title={label}>{label}</span>
      <div className="inp sel-ref" style={{ borderColor: value.length ? undefined : 'var(--accent-line)' }}>
        <span className="txt" title={value.length ? `${value.length} selected` : undefined} style={{ color: value.length ? 'var(--text)' : 'var(--text-faint)' }}>
          {value.length ? `${value.length} selected` : `Select ${accepts.join(' / ')}`}
        </span>
        <button type="button" className="icon-btn" title="Use current selection" aria-label="Use selection" onClick={() => onChange(encodeSelection(sel, useDoc.getState().geometry))}>
          <Crosshair size={12} />
        </button>
        {value.length > 0 && (
          <button type="button" className="icon-btn" title="Clear" aria-label="Clear" onClick={() => onChange([])}>
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

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
  const set: Setter = (key, v) => {
    const next = { ...latest.current, [key]: v }
    latest.current = next
    setValues(next)
    session.onChange?.(next)
  }
  return (
    <div className="panel">
      <div className="panel-title">{session.schema.title}</div>
      <div className="panel-scroll">
        <div className="section-body">
          {session.schema.params.filter((p) => p.type !== 'group').map((p, i) => (
            <Param key={i} def={p} values={values} set={set} />
          ))}
        </div>
        {session.schema.params.filter((p) => p.type === 'group').map((p, i) => (
          <Param key={i} def={p} values={values} set={set} />
        ))}
      </div>
      <div className="inspector-foot">
        <button type="button" className="btn" onClick={session.onCancel}>Cancel</button>
        <button type="button" className="btn primary" onClick={() => session.onOk(latest.current)}>OK</button>
      </div>
    </div>
  )
}
