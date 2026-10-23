import { useFrame } from '@react-three/fiber'
import { viewportBus } from './bus'

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
const HALF = 22

function faceMatrix(f: Face) {
  const d = cross(f.r, f.n) // down = r x n, so that r x d = -n
  const t = f.n.map((x) => x * HALF)
  return `matrix3d(${f.r.join(',')},0,${d.join(',')},0,${f.n.join(',')},0,${t.join(',')},1)`
}

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

/** DOM ViewCube; click a face to snap the view. */
export function ViewCube() {
  return (
    <div className="viewcube" title="Click a face to snap the view">
      <div className="vc-scene">
        {FACES.map((f) => (
          <button
            key={f.label}
            type="button"
            className="vc-face"
            style={{ transform: faceMatrix(f) }}
            onClick={() => viewportBus.emit('viewVec', f.n)}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  )
}
