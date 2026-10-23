/** Viewport side of the hair face selection: pointer handling, cyan overlay and the floating toolbar. */
import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { BufferAttribute, BufferGeometry, DoubleSide, Raycaster, Vector2, type Mesh } from 'three'
import { Cursor, HandPointing, PaintBrush, PaintBucket, Trash } from '@phosphor-icons/react'
import { useDoc } from '@/doc/store'
import { Tip } from '@/ui/Tooltip'
import { applyTris, brushTris, clearSelection, commitSelection, floodTris, selectedIndices, setPaint, useHairPaint, type PaintMode } from './paint'
import './hair.css'

/** Pointer-driven painting. Mounted inside the Canvas. */
export function HairPaintTool() {
  const { camera, gl, scene, invalidate } = useThree()
  const mode = useHairPaint((s) => s.mode)

  useEffect(() => {
    if (mode === 'off') return
    const el = gl.domElement
    const parent = el.parentElement
    const rc = new Raycaster()
    const ring = document.createElement('div')
    ring.className = 'hair-ring'
    parent?.appendChild(ring)
    const sizeRing = () => {
      const r = useHairPaint.getState().radius
      ring.style.width = ring.style.height = r * 2 + 'px'
      ring.style.display = mode === 'brush' ? 'block' : 'none'
    }
    sizeRing()
    const off = useHairPaint.subscribe(sizeRing)
    const prevCursor = el.style.cursor
    el.style.cursor = 'crosshair'
    let down = false

    const pick = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const mx = e.clientX - r.left, my = e.clientY - r.top
      rc.setFromCamera(new Vector2((mx / r.width) * 2 - 1, -(my / r.height) * 2 + 1), camera)
      const root = scene.getObjectByName('bodies')
      if (!root) return null
      const hit = rc.intersectObjects(root.children, true).find((h) => (h.object as Mesh).isMesh && h.faceIndex != null)
      if (!hit) return null
      const arr = (hit.object as Mesh).geometry.getAttribute('position').array
      const body = useDoc.getState().geometry.find((b) => b.mesh.positions === arr)
      return body ? { body, hit, mx, my, w: r.width, h: r.height } : null
    }
    const act = (e: PointerEvent) => {
      const p = pick(e)
      if (!p) return
      const st = useHairPaint.getState()
      const tri = p.hit.faceIndex!
      let tris = [tri]
      if (mode === 'brush') tris = [tri, ...brushTris(p.body, p.hit.point, camera, p.w, p.h, p.mx, p.my, st.radius)]
      else if (mode === 'flood') tris = floodTris(p.body, tri, st.angle, p.body.kind === 'brep')
      applyTris(p.body, tris, e.shiftKey)
      invalidate()
    }
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      down = true
      act(e)
    }
    const onMove = (e: PointerEvent) => {
      const r = (parent ?? el).getBoundingClientRect()
      const rad = useHairPaint.getState().radius
      ring.style.transform = `translate(${e.clientX - r.left - rad}px, ${e.clientY - r.top - rad}px)`
      if (down && mode === 'brush') act(e)
    }
    const onUp = () => {
      if (!down) return
      down = false
      commitSelection(useDoc.getState().geometry)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const r = useHairPaint.getState().radius
      if (e.key === '[') setPaint({ radius: Math.max(4, Math.round(r - Math.max(2, r * 0.15))) })
      else if (e.key === ']') setPaint({ radius: Math.min(200, Math.round(r + Math.max(2, r * 0.15))) })
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
      off()
      ring.remove()
      el.style.cursor = prevCursor
    }
  }, [mode, camera, gl, scene, invalidate])

  return null
}

/** Cyan highlight of the selected surface. Mounted inside the Canvas. */
export function HairRegionOverlay() {
  const { bodyId, sel, rev } = useHairPaint()
  const geometry = useDoc((s) => s.geometry)
  const { invalidate } = useThree()
  const geo = useMemo(() => {
    const body = geometry.find((b) => b.id === bodyId)
    if (!body || !sel.size) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(body.mesh.positions, 3))
    g.setIndex(new BufferAttribute(selectedIndices(body, sel), 1))
    return g
  }, [bodyId, sel, rev, geometry]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { invalidate(); return () => geo?.dispose() }, [geo, invalidate])
  if (!geo) return null
  return (
    <mesh geometry={geo} renderOrder={5} raycast={() => null}>
      <meshBasicMaterial color="#27d3e6" transparent opacity={0.55} side={DoubleSide} depthWrite={false} polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
    </mesh>
  )
}

const MODES: { id: PaintMode; label: string; icon: typeof Cursor; tip: string }[] = [
  { id: 'off', label: 'Pick', icon: Cursor, tip: 'Normal viewport picking' },
  { id: 'click', label: 'Face', icon: HandPointing, tip: 'Click a face or triangle (Shift erases)' },
  { id: 'brush', label: 'Brush', icon: PaintBrush, tip: 'Paint with the brush; [ ] changes size, Shift erases' },
  { id: 'flood', label: 'Fill', icon: PaintBucket, tip: 'Flood fill bounded by the angle threshold (Shift erases)' },
]

/** Floating toolbar over the viewport while the hair selection tools are open. */
export function HairPaintBar() {
  const { visible, mode, radius, angle, sel, kind } = useHairPaint()
  if (!visible) return null
  return (
    <div className="hair-bar">
      <div className="vp-bar">
        {MODES.map((m) => (
          <Tip key={m.id} label={m.tip} side="bottom">
            <button type="button" data-active={mode === m.id} onClick={() => setPaint({ mode: m.id })}><m.icon size={14} /> {m.label}</button>
          </Tip>
        ))}
        <span className="sep" />
        {mode === 'brush' && (
          <label className="hair-num" title="Brush radius in pixels ([ and ])">
            R
            <input type="number" min={4} max={200} value={radius} onChange={(e) => setPaint({ radius: Math.max(4, Math.min(200, +e.target.value || 28)) })} />
          </label>
        )}
        {mode === 'flood' && (
          <label className="hair-num" title="Maximum angle between neighbouring triangles">
            deg
            <input type="number" min={1} max={180} value={angle} onChange={(e) => setPaint({ angle: Math.max(1, Math.min(180, +e.target.value || 30)) })} />
          </label>
        )}
        <span className="hair-count">{sel.size ? `${sel.size.toLocaleString()} ${kind === 'brep' ? 'faces' : 'tris'}` : 'Nothing selected'}</span>
        <Tip label="Clear the selected surface" side="bottom">
          <button type="button" onClick={() => clearSelection(useDoc.getState().geometry)}><Trash size={14} /></button>
        </Tip>
      </div>
    </div>
  )
}
