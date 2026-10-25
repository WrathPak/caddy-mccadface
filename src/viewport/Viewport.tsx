import './bvh'
import { useRef } from 'react'
import { Canvas } from '@react-three/fiber'
import { ArrowsOut, Cube, CubeFocus, GridFour, Eye, Planet, Sun, Crosshair } from '@phosphor-icons/react'
import { useUi, type DisplayMode } from '@/store/ui'
import { Scene } from './Scene'
import { ViewCube } from './ViewCube'
import { MarkingMenu } from '@/ui/MarkingMenu'
import { Tip } from '@/ui/Tooltip'
import { runCommand } from '@/app/commands'
import { SketchHud } from '@/sketch/SketchHud'
import { HairPaintBar } from '@/features/hair/PaintTool'
import { useHairPaint } from '@/features/hair/paint'
import { PrintHud } from '@/features/print/PrintHud'
import { DrawingWorkspace } from '@/drawing/DrawingWorkspace'
import { RenderHud } from '@/render/RenderHud'

const MODES: { id: DisplayMode; label: string; icon: typeof Cube }[] = [
  { id: 'shaded', label: 'Shaded', icon: Cube },
  { id: 'shadedEdges', label: 'Shaded + edges', icon: CubeFocus },
  { id: 'wireframe', label: 'Wireframe', icon: GridFour },
  { id: 'xray', label: 'X-ray', icon: Eye },
]

export function Viewport() {
  const ref = useRef<HTMLDivElement>(null)
  const { displayMode, setDisplayMode, projection, ssao, showGrid, showOrigin } = useUi()
  const clear = useUi((s) => s.clearSelection)

  return (
    <div className="vp" ref={ref}>
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        gl={{ antialias: true, stencil: true, powerPreference: 'high-performance' }}
        raycaster={{ params: { Line: { threshold: 1.2 }, Mesh: {}, Points: { threshold: 1 }, LOD: {}, Sprite: {} } }}
        onCreated={({ gl }) => { gl.localClippingEnabled = true }}
        onPointerMissed={(e) => e.button === 0 && useHairPaint.getState().mode === 'off' && clear()}
      >
        <Scene />
      </Canvas>
      <ViewCube />
      <SketchHud />
      <HairPaintBar />
      <PrintHud />
      <RenderHud />
      <DrawingWorkspace />
      <div className="vp-toolbar">
        <div className="vp-bar">
          {MODES.map((m) => (
            <Tip key={m.id} label={m.label} side="top">
              <button type="button" data-active={displayMode === m.id} onClick={() => setDisplayMode(m.id)}>
                <m.icon size={14} />
              </button>
            </Tip>
          ))}
        </div>
        <div className="vp-bar">
          <Tip label={projection === 'perspective' ? 'Perspective' : 'Orthographic'} shortcut="Shift+P" side="top">
            <button type="button" data-active={projection === 'orthographic'} onClick={() => runCommand('view.ortho')}>
              <Planet size={14} /> {projection === 'perspective' ? 'Persp' : 'Ortho'}
            </button>
          </Tip>
          <Tip label="Ambient occlusion" side="top">
            <button type="button" data-active={ssao} onClick={() => runCommand('view.ssao')}><Sun size={14} /> AO</button>
          </Tip>
          <span className="sep" />
          <Tip label="Grid" side="top">
            <button type="button" data-active={showGrid} onClick={() => useUi.setState({ showGrid: !showGrid })}><GridFour size={14} /></button>
          </Tip>
          <Tip label="Origin" side="top">
            <button type="button" data-active={showOrigin} onClick={() => useUi.setState({ showOrigin: !showOrigin })}><Crosshair size={14} /></button>
          </Tip>
          <Tip label="Frame all" shortcut="F6" side="top">
            <button type="button" onClick={() => runCommand('view.frame')}><ArrowsOut size={14} /></button>
          </Tip>
        </div>
      </div>
      <MarkingMenu target={ref} />
    </div>
  )
}
