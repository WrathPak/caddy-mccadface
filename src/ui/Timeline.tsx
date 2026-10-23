import { useRef } from 'react'
import type { Icon } from '@phosphor-icons/react'
import { ArrowArcRight, ArrowFatLineUp, ArrowsClockwise, ArrowsOutCardinal, Circle, GridFour, PencilSimpleLine, Polygon, Question, Spiral } from '@phosphor-icons/react'
import { useDoc } from '@/doc/store'
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
export const featureIcon = (type: string): Icon => ICONS[type] ?? Question

export interface TimelineProps {
  /** double-click on a chip; real document engine opens the feature's Inspector here */
  onEditFeature?: (id: string) => void
}

/** Feature chips with a draggable rollback marker. Data comes from the doc store. */
export function Timeline({ onEditFeature }: TimelineProps) {
  const { features, rollback, selectedFeatureId, selectFeature, setRollback, toggleSuppress } = useDoc()
  const setActiveTool = useUi((s) => s.setActiveTool)
  const trackRef = useRef<HTMLDivElement>(null)

  const edit = (id: string) => {
    selectFeature(id)
    if (onEditFeature) onEditFeature(id)
    else console.info('[timeline] edit', id)
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

  return (
    <div className="tl">
      <div className="tl-track" ref={trackRef}>
        {rollback === 0 && marker}
        {features.map((f, i) => {
          const I = featureIcon(f.type)
          return [
            <Tip key={f.id} label={f.state === 'error' && f.error ? `${f.name}: ${f.error}` : f.name}>
              <button
                type="button"
                className="chip"
                data-state={f.state}
                data-selected={selectedFeatureId === f.id}
                data-rolled={i >= rollback}
                onClick={() => selectFeature(f.id)}
                onDoubleClick={() => edit(f.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') edit(f.id); if (e.key === 'u') toggleSuppress(f.id) }}
              >
                <I size={16} />
              </button>
            </Tip>,
            i + 1 === rollback ? marker : null,
          ]
        })}
        {features.length === 0 && <span className="empty" style={{ padding: 0 }}>No features yet</span>}
      </div>
    </div>
  )
}
