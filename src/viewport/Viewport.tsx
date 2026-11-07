import './bvh'
import { useRef } from 'react'
import { Canvas, events } from '@react-three/fiber'
import { handlesOnly, ownedGesture } from './handles'
import { useUi } from '@/store/ui'
import { Scene } from './Scene'
import { ViewCube } from './ViewCube'
import { MarkingMenu } from '@/ui/MarkingMenu'
import { SketchHud } from '@/sketch/SketchHud'
import { HairPaintBar } from '@/features/hair/PaintTool'
import { MeshStatsCard } from '@/features/mesh/stats'
import { useHairPaint } from '@/features/hair/paint'
import { PrintHud } from '@/features/print/PrintHud'
import { DrawingWorkspace } from '@/drawing/DrawingWorkspace'
import { RenderHud } from '@/render/RenderHud'
import { AssemblyHud } from '@/assembly/AssemblyHud'
import { EmptyHint } from '@/help/EmptyHint'
import { useSettings, dprRange } from '@/settings/settings'
import { useDevice } from '@/app/device'

export function Viewport() {
  const ref = useRef<HTMLDivElement>(null)
  const clear = useUi((s) => s.clearSelection)
  const pixelRatio = useSettings((s) => s.pixelRatio)
  const coarse = useDevice((s) => s.coarse)

  return (
    <div className="vp" ref={ref}>
      <EmptyHint />
      <Canvas
        frameloop="demand"
        dpr={dprRange(pixelRatio, coarse)}
        gl={{ antialias: true, stencil: true, powerPreference: 'high-performance' }}
        raycaster={{ params: { Line: { threshold: 1.2 }, Mesh: {}, Points: { threshold: 1 }, LOD: {}, Sprite: {} } }}
        events={(store) => ({ ...events(store), filter: handlesOnly })}
        onCreated={({ gl }) => { gl.localClippingEnabled = true }}
        onPointerMissed={(e) => e.button === 0 && !ownedGesture() && useHairPaint.getState().mode === 'off' && clear()}
      >
        <Scene />
      </Canvas>
      <ViewCube />
      <SketchHud />
      <HairPaintBar />
      <MeshStatsCard />
      <PrintHud />
      <RenderHud />
      <DrawingWorkspace />
      <AssemblyHud />
      <MarkingMenu target={ref} />
    </div>
  )
}
