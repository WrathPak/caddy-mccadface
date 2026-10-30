/** Viewport layer of the DETAIL tools: emboss / engrave solid, textured model preview, the on-surface text handle and the readout. */
import { markGrab } from '@/viewport/touchGrab'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Html } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BufferAttribute, BufferGeometry, DoubleSide, MathUtils, Matrix4, Plane, Raycaster, Vector2, Vector3, type Mesh, type OrthographicCamera, type PerspectiveCamera,
} from 'three'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { frameAt, spin } from '@/kernel/generators/surface'
import type { TopoMesh } from '@/kernel/types'
import { useVpColors } from '@/viewport/colors'
import { useDetailView, type EmbossView } from './store'
import { DEBUG_HANDLE } from '@/app/flags'

type V3 = [number, number, number]

/** Indexed mesh with sharp edges kept sharp and curved parts smooth. */
function useCreased(m: TopoMesh | null | undefined, angleDeg: number) {
  const geo = useMemo(() => {
    if (!m) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(m.positions, 3))
    g.setIndex(new BufferAttribute(m.indices, 1))
    const out = toCreasedNormals(g, (angleDeg * Math.PI) / 180)
    g.dispose()
    out.computeBoundingSphere()
    return out
  }, [m, angleDeg])
  useEffect(() => () => geo?.dispose(), [geo])
  return geo
}

function ToolMesh({ view }: { view: EmbossView }) {
  const colors = useVpColors()
  const { invalidate } = useThree()
  const geo = useCreased(view.mesh, 40)
  useEffect(() => { invalidate() }, [geo, invalidate])
  if (!geo) return null
  const cut = view.mode === 'engrave'
  return (
    <mesh geometry={geo} renderOrder={6} raycast={() => null}>
      <meshStandardMaterial color={cut ? '#d9625a' : colors.accent} roughness={0.55} transparent opacity={cut ? 0.7 : 0.85} side={DoubleSide} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
    </mesh>
  )
}

function TextureMesh() {
  const t = useDetailView((s) => s.texture)
  const colors = useVpColors()
  const { invalidate } = useThree()
  const geo = useCreased(t?.mesh, 38)
  useEffect(() => { invalidate() }, [geo, invalidate])
  if (!geo) return null
  return (
    <mesh geometry={geo} raycast={() => null} renderOrder={6}>
      <meshStandardMaterial color={colors.body} roughness={0.62} metalness={0.05} side={DoubleSide} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} />
    </mesh>
  )
}

/** Rotation-free tangent frame at a point, the same one the kernel lays the artwork out in. */
export function baseFrame(point: V3, normal: V3) {
  return frameAt(point, normal, [0, 0, 1])
}

function EmbossHandle({ view }: { view: EmbossView }) {
  const colors = useVpColors()
  const { camera, gl, scene, invalidate } = useThree()
  const knob = useRef<Mesh>(null)
  const [hot, setHot] = useState<'move' | 'turn' | null>(null)
  const f = useMemo(() => spin(baseFrame(view.point, view.normal), view.rotation), [view.point, view.normal, view.rotation])
  const basis = useMemo(() => {
    const m = new Matrix4().makeBasis(new Vector3(...f.x), new Vector3(...f.y), new Vector3(...f.n))
    return m
  }, [f])
  const w = Math.max(view.width, 2), h = Math.max(view.height, 2)
  const lift = 0.05

  // constant on-screen size for the knob
  useFrame((state) => {
    const k = knob.current
    if (!k) return
    const cam = state.camera as PerspectiveCamera & OrthographicCamera
    const p = new Vector3(...view.point)
    const s = cam.isOrthographicCamera ? 9 / cam.zoom : (cam.position.distanceTo(p) * 2 * Math.tan(MathUtils.degToRad(cam.fov) / 2) * 9) / state.size.height
    k.scale.setScalar(s)
  })

  const rayAt = (e: PointerEvent) => {
    const r = gl.domElement.getBoundingClientRect()
    const rc = new Raycaster()
    rc.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
    return rc
  }
  const surfaceHit = (rc: Raycaster) => {
    const root = scene.getObjectByName('bodies')
    if (!root) return null
    const hit = rc.intersectObjects(root.children, true).find((i) => (i.object as Mesh).isMesh && i.faceIndex != null)
    return hit ? ([hit.point.x, hit.point.y, hit.point.z] as V3) : null
  }
  const drag = (kind: 'move' | 'turn') => (e: { stopPropagation(): void; nativeEvent: PointerEvent }) => {
    e.stopPropagation()
    markGrab()
    const base = baseFrame(view.point, view.normal)
    const plane = new Plane().setFromNormalAndCoplanarPoint(new Vector3(...view.normal), new Vector3(...view.point))
    const move = (ev: PointerEvent) => {
      const rc = rayAt(ev)
      if (kind === 'move') {
        const p = surfaceHit(rc)
        if (p) useDetailView.getState().emboss?.moveTo(p.map((x) => +x.toFixed(3)) as V3)
      } else {
        const hit = new Vector3()
        if (!rc.ray.intersectPlane(plane, hit)) return
        const v = hit.sub(new Vector3(...view.point))
        if (v.length() < 1e-6) return
        const vx = v.x * base.x[0] + v.y * base.x[1] + v.z * base.x[2]
        const vy = v.x * base.y[0] + v.y * base.y[1] + v.z * base.y[2]
        let deg = (Math.atan2(-vx, vy) * 180) / Math.PI
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15
        useDetailView.getState().emboss?.rotateTo(+deg.toFixed(1))
      }
      invalidate()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      gl.domElement.style.cursor = ''
    }
    gl.domElement.style.cursor = 'grabbing'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const color = '#e8b84a'
  const outline = useMemo(() => {
    const g = new BufferGeometry()
    const x = w / 2 + 0.6, y = h / 2 + 0.6
    g.setAttribute('position', new BufferAttribute(Float32Array.from([-x, -y, 0, x, -y, 0, x, y, 0, -x, y, 0]), 3))
    return g
  }, [w, h])
  useEffect(() => () => outline.dispose(), [outline])
  return (
    <HandleBody basis={basis} point={view.point} lift={lift}>
        <lineLoop geometry={outline} renderOrder={21} raycast={() => null}>
          <lineBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
        </lineLoop>
        {/* the plate is the grab area for moving; it is invisible but takes the pointer */}
        <mesh
          renderOrder={20}
          userData={{ handle: true }}
          onPointerDown={drag('move') as never}
          onPointerOver={() => { setHot('move'); gl.domElement.style.cursor = 'grab' }}
          onPointerOut={() => { setHot(null); gl.domElement.style.cursor = '' }}
        >
          <planeGeometry args={[w + 1.2, h + 1.2]} />
          <meshBasicMaterial color={color} transparent opacity={hot === 'move' ? 0.14 : 0.05} depthTest={false} side={DoubleSide} />
        </mesh>
        <mesh position={[0, h / 2 + 0.6, 0]} renderOrder={22} raycast={() => null}>
          <cylinderGeometry args={[0.04, 0.04, 1, 6]} />
          <meshBasicMaterial color={color} depthTest={false} transparent />
        </mesh>
        <mesh
          ref={knob} position={[0, h / 2 + 0.6, 0]} renderOrder={23} userData={{ handle: true }}
          onPointerDown={drag('turn') as never}
          onPointerOver={() => { setHot('turn'); gl.domElement.style.cursor = 'grab' }}
          onPointerOut={() => { setHot(null); gl.domElement.style.cursor = '' }}
        >
          <sphereGeometry args={[1, 16, 12]} />
          <meshBasicMaterial color={hot === 'turn' ? colors.accent : color} depthTest={false} transparent />
        </mesh>
    </HandleBody>
  )
}

/** Places its children at the point, oriented by the basis, floated a hair above the surface. */
function HandleBody({ basis, point, lift, children }: { basis: Matrix4; point: V3; lift: number; children: React.ReactNode }) {
  const m = useMemo(() => {
    const out = basis.clone()
    out.setPosition(point[0] + basis.elements[8] * lift, point[1] + basis.elements[9] * lift, point[2] + basis.elements[10] * lift)
    return out
  }, [basis, point, lift])
  return <group matrixAutoUpdate={false} matrix={m}>{children}</group>
}

function Readout() {
  const text = useDetailView((s) => s.readout)
  const busy = useDetailView((s) => s.busy)
  if (!text && !busy) return null
  return (
    <Html fullscreen zIndexRange={[24, 0]} style={{ pointerEvents: 'none' }}>
      <div className="detail-readout" data-testid="detail-readout">{busy ? 'Working ...' : text}</div>
    </Html>
  )
}

/** Mounted once inside the Canvas. */
export function DetailOverlay() {
  // dev builds: expose the preview state to the e2e specs
  useEffect(() => {
    if (!DEBUG_HANDLE) return
    const handle = (window as unknown as { __caddy?: Record<string, unknown> }).__caddy
    if (handle) handle.detail = useDetailView
  }, [])
  const emboss = useDetailView((s) => s.emboss)
  return (
    <>
      {emboss && <ToolMesh view={emboss} />}
      {emboss && <EmbossHandle view={emboss} />}
      <TextureMesh />
      <Readout />
    </>
  )
}
