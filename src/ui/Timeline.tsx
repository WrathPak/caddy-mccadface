import { useRef } from 'react'
import type { Icon } from '@phosphor-icons/react'
import { ArrowArcRight, ArrowFatLineUp, ArrowsClockwise, ArrowsOutCardinal, Circle, GridFour, PencilSimpleLine, Polygon, Question, Spiral } from '@phosphor-icons/react'
import { useDoc, activeDefId } from '@/doc/store'
import { activateOcc } from '@/assembly/actions'
import { flatten } from '@/assembly/instances'
import { ROOT } from '@/assembly/types'
import { getFeature } from '@/doc/registry'
import { editFeature } from '@/doc/editor'
import { useUi } from '@/store/ui'
import { Tip } from './Tooltip'

const ICONS: Record<string, Icon> = {
  sketch: PencilSimpleLine,
  extrude: ArrowFatLineUp,
  revolve: ArrowsClockwise,
  fillet: Circle,
  chamfer: Polygon,
  move: ArrowsOutCardinal,
  importMesh: GridFour,
  hair: Spiral,
  arc: ArrowArcRight,
}
export const featureIcon = (type: string): Icon => getFeature(type)?.icon ?? ICONS[type] ?? Question

export interface TimelineProps {
  /** double-click on a chip; real document engine opens the feature's Inspector here */
  onEditFeature?: (id: string) => void
}

/** Feature chips with a draggable rollback marker. Data comes from the doc store. */
export function Timeline({ onEditFeature }: TimelineProps) {
  const { features, rollback, selectedFeatureId, selectFeature, setRollback, toggleSuppress } = useDoc()
  const setActiveTool = useUi((s) => s.setActiveTool)
  const trackRef = useRef<HTMLDivElement>(null)
  const assembly = useDoc((s) => s.assembly)
  const activeOcc = useDoc((s) => s.activeOcc)
  const activeDef = activeDefId({ activeOcc, assembly })
  // with components the timeline is drawn in one section per component (runs of features that belong to the same one)
  const sectioned = assembly.occurrences.length > 0

  const edit = (id: string) => {
    selectFeature(id)
    if (onEditFeature) onEditFeature(id)
    else editFeature(id)
    setActiveTool(null)
  }

  const dragMarker = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const chips = () => [...(trackRef.current?.querySelectorAll<HTMLElement>('.chip') ?? [])]
    const move = (ev: PointerEvent) => {
      // marker index = number of chips whose centre is left of the pointer
      const n = chips().filter((c) => {
        const r = c.getBoundingClientRect()
        return r.left + r.width / 2 < ev.clientX
      }).length
      setRollback(n)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const marker = (
    <div key="marker" className="marker" onPointerDown={dragMarker} title="Rollback marker" />
  )

  const chipOf = (f: (typeof features)[number], i: number) => {
    const I = featureIcon(f.type)
    const comp = f.component ?? ROOT
    return [
      <Tip key={f.id} label={f.state === 'error' && f.error ? `${f.name}: ${f.error}` : f.state === 'warning' && f.warning ? `${f.name}: ${f.warning}` : f.name}>
        <button
          type="button"
          className="chip"
          data-state={f.state}
          data-selected={selectedFeatureId === f.id}
          data-rolled={i >= rollback}
          data-dim={sectioned && comp !== activeDef}
          onClick={() => selectFeature(f.id)}
          onDoubleClick={() => edit(f.id)}
          onKeyDown={(e) => { if (e.key === 'Enter') edit(f.id); if (e.key === 'u') toggleSuppress(f.id) }}
        >
          <I size={16} />
        </button>
      </Tip>,
      i + 1 === rollback ? marker : null,
    ]
  }

  if (sectioned) {
    const sections: { comp: string; items: { f: (typeof features)[number]; i: number }[] }[] = []
    features.forEach((f, i) => {
      const comp = f.component ?? ROOT
      const last = sections[sections.length - 1]
      if (last && last.comp === comp) last.items.push({ f, i })
      else sections.push({ comp, items: [{ f, i }] })
    })
    const nodes = flatten(assembly)
    const hue = (comp: string) => (Math.max(0, assembly.components.findIndex((c) => c.id === comp)) * 67 + 190) % 360
    return (
      <div className="tl">
        <div className="tl-track" ref={trackRef}>
          {rollback === 0 && marker}
          {sections.map((s, n) => {
            const name = s.comp === ROOT ? 'Root' : assembly.components.find((c) => c.id === s.comp)?.name ?? s.comp
            return (
              <div key={n} className="tl-sec" data-testid={'tl-sec-' + s.comp} data-active={s.comp === activeDef} style={{ ['--sec' as string]: `hsl(${hue(s.comp)} 45% 55%)` }}>
                <Tip label={s.comp === activeDef ? `${name} is the active component` : `Make ${name} the active component`}>
                  <button type="button" className="tl-sec-label" onClick={() => activateOcc(s.comp === ROOT ? null : nodes.find((x) => x.component === s.comp)?.id ?? null)}>{name}</button>
                </Tip>
                <div className="tl-sec-chips">{s.items.map(({ f, i }) => chipOf(f, i))}</div>
              </div>
            )
          })}
          {features.length === 0 && <span className="empty" style={{ padding: 0 }}>No features yet</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="tl">
      <div className="tl-track" ref={trackRef}>
        {rollback === 0 && marker}
        {features.map((f, i) => chipOf(f, i))}
        {features.length === 0 && <span className="empty" style={{ padding: 0 }}>No features yet</span>}
      </div>
    </div>
  )
}
