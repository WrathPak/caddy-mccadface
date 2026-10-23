import { useEffect, useState } from 'react'
import { useUi } from '@/store/ui'
import { NumberField } from './NumberField'
import { Select } from './Select'
import { Checkbox } from './Toggle'
import { Segmented } from './Segmented'
import { Section } from './Section'
import type { ParamDef, ParamValue, ParamValues } from './schema'

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
        <NumberField label={def.label} value={v as number} unit={def.unit} min={def.min} max={def.max} step={def.step}
          onChange={(n) => set(def.key, n)} />
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
      const vec = v as [number, number, number]
      return (
        <div className="field">
          <span className="field-label">{def.label}</span>
          <div className="vec3">
            {(['X', 'Y', 'Z'] as const).map((ax, i) => (
              <NumberField key={ax} value={vec[i]} step={def.step} unit={def.unit}
                prefix={<span className={'mono axis-' + ax.toLowerCase()} style={{ marginRight: 3 }}>{ax}</span>}
                onChange={(n) => { const c: [number, number, number] = [...vec]; c[i] = n; set(def.key, c) }} />
            ))}
          </div>
        </div>
      )
    }
    case 'selection-ref':
      return <SelectionRef label={def.label} accepts={def.accepts} value={v as string[]} onChange={(s) => set(def.key, s)} />
  }
}

function SelectionRef({ label, accepts, value, onChange }: { label: string; accepts: string[]; value: string[]; onChange: (s: string[]) => void }) {
  const sel = useUi((s) => s.selection)
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="inp" style={{ gap: 6, borderColor: value.length ? undefined : 'var(--accent-line)' }}>
        <span style={{ flex: 1, color: value.length ? 'var(--text)' : 'var(--text-faint)' }}>
          {value.length ? `${value.length} selected` : `Select ${accepts.join(' / ')}`}
        </span>
        <button type="button" className="btn" style={{ height: 16, padding: '0 5px', fontSize: 10 }}
          onClick={() => onChange(sel.map((r) => r.id + (r.index !== undefined ? ':' + r.index : '')))}>
          Use sel.
        </button>
        {value.length > 0 && (
          <button type="button" className="btn" style={{ height: 16, padding: '0 5px', fontSize: 10 }} onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
    </div>
  )
}

/** Schema-driven feature dialog. Renders `ui.inspector` (any ParamSchema) with OK / Cancel. */
export function Inspector() {
  const session = useUi((s) => s.inspector)
  const [values, setValues] = useState<ParamValues>({})
  useEffect(() => {
    if (session) setValues(session.values)
  }, [session])

  if (!session) return <div className="panel"><div className="panel-title">Inspector</div><div className="empty">Select a feature or start a tool to edit its parameters.</div></div>

  const set: Setter = (key, v) => {
    setValues((prev) => {
      const next = { ...prev, [key]: v }
      session.onChange?.(next)
      return next
    })
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
        <button type="button" className="btn primary" onClick={() => session.onOk(values)}>OK</button>
      </div>
    </div>
  )
}
