import './bvh'
import { useRef } from 'react'
import { Canvas, events } from '@react-three/fiber'
import { handlesOnly, ownedGesture } from './handles'
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
import { AssemblyHud } from '@/assembly/AssemblyHud'
import { EmptyHint } from '@/help/EmptyHint'
import { useSettings, dprRange } from '@/settings/settings'
import { useDevice } from '@/app/device'

const MODES: { id: DisplayMode; label: string; icon: typeof Cube; desc: string }[] = [
  { id: 'shaded', label: 'Shaded', icon: Cube, desc: 'Solid colored surfaces without edge lines.' },
  { id: 'shadedEdges', label: 'Shaded + edges', icon: CubeFocus, desc: 'Solid surfaces with dark outlines along the edges. The usual choice.' },
  { id: 'wireframe', label: 'Wireframe', icon: GridFour, desc: 'Only the edges, so you can see through the model.' },
  { id: 'xray', label: 'X-ray', icon: Eye, desc: 'See-through surfaces, to check what is inside or behind.' },
]

export function Viewport() {
  const ref = useRef<HTMLDivElement>(null)
  const displayMode = useUi((s) => s.displayMode), setDisplayMode = useUi((s) => s.setDisplayMode)
  const projection = useUi((s) => s.projection), ssao = useUi((s) => s.ssao)
  const showGrid = useUi((s) => s.showGrid), showOrigin = useUi((s) => s.showOrigin)
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
      <PrintHud />
      <RenderHud />
      <DrawingWorkspace />
      <AssemblyHud />
      <div className="vp-toolbar">
        <div className="vp-bar">
          {MODES.map((m) => (
            <Tip key={m.id} label={m.label} desc={m.desc} side="top">
              <button type="button" aria-label={m.label} data-active={displayMode === m.id} onClick={() => setDisplayMode(m.id)}>
                <m.icon size={14} />
              </button>
            </Tip>
          ))}
        </div>
        <div className="vp-bar">
          <Tip label={projection === 'perspective' ? 'Perspective' : 'Orthographic'} desc="Perspective makes distant things smaller, like a camera. Orthographic keeps sizes true, which is better for measuring and checking shapes. Click to switch." shortcut="Shift+P" side="top">
            <button type="button" data-active={projection === 'orthographic'} onClick={() => runCommand('view.ortho')}>
              <Planet size={14} /> {projection === 'perspective' ? 'Persp' : 'Ortho'}
            </button>
          </Tip>
          <Tip label="Ambient occlusion" desc="Soft shadows in creases and corners that make shapes easier to read. Turn it off if the view feels slow." side="top">
            <button type="button" data-active={ssao} onClick={() => runCommand('view.ssao')}><Sun size={14} /> AO</button>
          </Tip>
          <span className="sep" />
          <Tip label="Grid" desc="Show or hide the grid on the floor." side="top">
            <button type="button" aria-label="Grid" data-active={showGrid} onClick={() => useUi.setState({ showGrid: !showGrid })}><GridFour size={14} /></button>
          </Tip>
          <Tip label="Origin" desc="Show or hide the colored axes where X, Y and Z start." side="top">
            <button type="button" aria-label="Origin" data-active={showOrigin} onClick={() => useUi.setState({ showOrigin: !showOrigin })}><Crosshair size={14} /></button>
          </Tip>
          <Tip label="Frame all" desc="Zoom and move the camera so everything fits in the window." shortcut="F6" side="top">
            <button type="button" aria-label="Frame all" onClick={() => runCommand('view.frame')}><ArrowsOut size={14} /></button>
          </Tip>
        </div>
      </div>
      <MarkingMenu target={ref} />
    </div>
  )
}
