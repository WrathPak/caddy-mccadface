/**
 * Stencil capping for Section Analysis: the clipped body is drawn twice into the stencil buffer (back faces count up, front
 * faces count down, both clipped), so the stencil is non-zero exactly where the cut plane passes through solid material.
 * A hatched, tinted quad lying on the plane is then drawn only where the stencil is set, and the stencil is cleared for the
 * next body.
 */
import { useEffect, useMemo } from 'react'
import {
  AlwaysStencilFunc, BackSide, CanvasTexture, Color, DecrementWrapStencilOp, DoubleSide, FrontSide, IncrementWrapStencilOp,
  NotEqualStencilFunc, Quaternion, ReplaceStencilOp, RepeatWrapping, Vector3, type BufferGeometry, type Plane, type WebGLRenderer,
} from 'three'

/** Tinted hatch texture (one tile = 8 world units, see `tile`). */
function hatch(color: string) {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  g.fillStyle = color
  g.fillRect(0, 0, 64, 64)
  g.strokeStyle = 'rgba(0,0,0,0.38)'
  g.lineWidth = 3
  g.beginPath()
  for (let k = -64; k <= 128; k += 16) { g.moveTo(k, 64); g.lineTo(k + 64, 0) }
  g.stroke()
  const t = new CanvasTexture(c)
  t.wrapS = t.wrapT = RepeatWrapping
  return t
}

const tile = 8

export function SectionCap({ geometry, plane, color, order, size }: { geometry: BufferGeometry; plane: Plane; color: string; order: number; size: number }) {
  const clip = useMemo(() => [plane], [plane])
  const tex = useMemo(() => { const t = hatch(color); t.repeat.set((size * 2) / tile, (size * 2) / tile); return t }, [color, size])
  useEffect(() => () => tex.dispose(), [tex])
  const quat = useMemo(() => new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), plane.normal.clone().normalize()), [plane])
  const pos = useMemo(() => plane.normal.clone().multiplyScalar(-plane.constant), [plane])
  const stencil = (side: typeof BackSide | typeof FrontSide, op: typeof IncrementWrapStencilOp | typeof DecrementWrapStencilOp) => ({
    side, colorWrite: false, depthWrite: false, depthTest: false, stencilWrite: true, stencilFunc: AlwaysStencilFunc,
    stencilFail: op, stencilZFail: op, stencilZPass: op, clippingPlanes: clip,
  })
  const white = useMemo(() => new Color('#ffffff'), [])
  return (
    <group name="section-cap">
      <mesh geometry={geometry} renderOrder={order} raycast={() => null}>
        <meshBasicMaterial {...stencil(BackSide, IncrementWrapStencilOp)} />
      </mesh>
      <mesh geometry={geometry} renderOrder={order} raycast={() => null}>
        <meshBasicMaterial {...stencil(FrontSide, DecrementWrapStencilOp)} />
      </mesh>
      <mesh
        name="section-cap-face"
        position={pos}
        quaternion={quat}
        renderOrder={order + 1}
        raycast={() => null}
        onAfterRender={(r: WebGLRenderer) => r.clearStencil()}
      >
        <planeGeometry args={[size * 2, size * 2]} />
        <meshBasicMaterial
          map={tex} color={white} side={DoubleSide}
          stencilWrite stencilRef={0} stencilFunc={NotEqualStencilFunc}
          stencilFail={ReplaceStencilOp} stencilZFail={ReplaceStencilOp} stencilZPass={ReplaceStencilOp}
        />
      </mesh>
    </group>
  )
}
