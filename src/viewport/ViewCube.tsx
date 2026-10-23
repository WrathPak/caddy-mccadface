import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useFrame } from '@react-three/fiber'
import { ArrowArcLeft, ArrowArcRight, CaretDown, CaretLeft, CaretRight, CaretUp, House } from '@phosphor-icons/react'
import { viewportBus, type StepKind } from './bus'

type V = [number, number, number]
interface Face { label: string; n: V; r: V }

/** n = outward normal (world, Z up). r = on-screen "right" of the label when viewed from outside. */
const FACES: Face[] = [
  { label: 'Top', n: [0, 0, 1], r: [1, 0, 0] },
  { label: 'Bottom', n: [0, 0, -1], r: [1, 0, 0] },
  { label: 'Front', n: [0, -1, 0], r: [1, 0, 0] },
  { label: 'Back', n: [0, 1, 0], r: [-1, 0, 0] },
  { label: 'Right', n: [1, 0, 0], r: [0, 1, 0] },
  { label: 'Left', n: [-1, 0, 0], r: [0, -1, 0] },
]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const HALF = 28
/** width of the edge / corner zones in px */
const BEVEL = 9

function faceMatrix(f: Face) {
  const d = cross(f.r, f.n) // down = r x n, so that r x d = -n
  const t = f.n.map((x) => x * HALF)
  return `matrix3d(${f.r.join(',')},0,${d.join(',')},0,${f.n.join(',')},0,${t.join(',')},1)`
}

/** The 3 x 3 clickable zones of a face: centre = the face, sides = the 4 edges, corners = the 4 corners. */
interface Zone { key: string; kind: 'face' | 'edge' | 'corner'; label: string }
function zonesOf(f: Face): Zone[] {
  const d = cross(f.r, f.n)
  const out: Zone[] = []
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      // the view direction of the zone: the face normal plus the in-face offsets (all axis aligned, so the sum is exact)
      const v = [0, 1, 2].map((k) => f.n[k] + i * f.r[k] + j * d[k])
      const kind = i === 0 && j === 0 ? 'face' : i === 0 || j === 0 ? 'edge' : 'corner'
      out.push({ key: v.join(','), kind, label: kind === 'face' ? f.label : '' })
    }
  }
  return out
}
const ZONES = FACES.map(zonesOf)

/** Mounted inside the Canvas: mirrors the camera rotation onto the DOM cube. */
export function ViewCubeSync() {
  useFrame((state) => {
    const scene = document.querySelector<HTMLElement>('.vc-scene')
    if (!scene) return
    const e = state.camera.matrixWorldInverse.elements
    // world -> camera rotation, with Y flipped for CSS (y down)
    scene.style.transform = `matrix3d(${e[0]},${-e[1]},${e[2]},0,${e[4]},${-e[5]},${e[6]},0,${e[8]},${-e[9]},${e[10]},0,0,0,0,1)`
    const faces = scene.children
    for (let i = 0; i < FACES.length; i++) {
      const n = FACES[i].n
      // camera-space z of the normal: >0 faces the viewer
      const z = e[2] * n[0] + e[6] * n[1] + e[10] * n[2]
      ;(faces[i] as HTMLElement).style.visibility = z > 0.02 ? 'visible' : 'hidden'
    }
  })
  return null
}

const ARROWS: { kind: StepKind; label: string; cls: string; icon: typeof CaretUp }[] = [
  { kind: 'up', label: 'Rotate up 90°', cls: 'up', icon: CaretUp },
  { kind: 'down', label: 'Rotate down 90°', cls: 'down', icon: CaretDown },
  { kind: 'left', label: 'Rotate left 90°', cls: 'left', icon: CaretLeft },
  { kind: 'right', label: 'Rotate right 90°', cls: 'right', icon: CaretRight },
  { kind: 'rollCCW', label: 'Roll counter-clockwise 90°', cls: 'roll-ccw', icon: ArrowArcLeft },
  { kind: 'rollCW', label: 'Roll clockwise 90°', cls: 'roll-cw', icon: ArrowArcRight },
]

/**
 * DOM ViewCube: 6 faces, 12 edges and 8 corners are clickable (each highlights on hover and snaps the view with an animated
 * transition), dragging the cube orbits, the arrows turn the view in 90 degree steps or roll it, and the house goes home.
 */
export function ViewCube() {
  const [hot, setHot] = useState<string | null>(null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const zoneAt = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.('[data-zone]')?.getAttribute('data-zone') ?? null

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, moved: false }
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return setHot(zoneAt(e.target))
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) {
      d.moved = true
      setHot(null)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    if (d.moved) {
      viewportBus.emit('orbit', { dx: e.clientX - d.x, dy: e.clientY - d.y })
      d.x = e.clientX
      d.y = e.clientY
    }
  }
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    const key = zoneAt(e.target)
    if (key) viewportBus.emit('viewVec', key.split(',').map(Number) as V)
  }

  return (
    <div className="viewcube" data-testid="viewcube">
      <div className="vc-stage" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={() => !drag.current && setHot(null)} title="Click a face, edge or corner to snap the view; drag to orbit">
        <div className="vc-scene">
          {FACES.map((f, fi) => (
            <div key={f.label} className="vc-face" data-face={f.label} style={{ transform: faceMatrix(f), gridTemplateColumns: `${BEVEL}px 1fr ${BEVEL}px`, gridTemplateRows: `${BEVEL}px 1fr ${BEVEL}px` }}>
              {ZONES[fi].map((z, zi) => (
                <div key={zi} className={'vc-zone ' + z.kind} data-zone={z.key} data-kind={z.kind} data-hot={hot === z.key}>
                  {z.label}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <button type="button" className="vc-btn home" title="Home view" aria-label="Home view" onClick={() => viewportBus.emit('view', 'home')}>
        <House size={14} weight="fill" />
      </button>
      {ARROWS.map((a) => (
        <button key={a.kind} type="button" className={'vc-btn ' + a.cls} title={a.label} aria-label={a.label} onClick={() => viewportBus.emit('step', a.kind)}>
          <a.icon size={a.kind.startsWith('roll') ? 15 : 13} weight="bold" />
        </button>
      ))}
    </div>
  )
}
