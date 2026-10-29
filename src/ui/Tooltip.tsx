import * as T from '@radix-ui/react-tooltip'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Command } from '@/app/commands'
import { helpFor } from '@/help/commandHelp'
import { useSettings } from '@/settings/settings'

/** true under a TooltipProvider; React roots of their own (the canvas, drei's Html) don't inherit it */
const HasProvider = createContext(false)

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <T.Provider delayDuration={400} skipDelayDuration={250}>
    <HasProvider.Provider value={true}>{children}</HasProvider.Provider>
  </T.Provider>
)

/** How long a finger has to rest on a control before its tip shows (touch screens have no hover). */
const LONG_PRESS_MS = 450
/** A held finger that moves further than this is a scroll or a drag, not a long press. */
const SLOP = 10

export interface TipProps {
  /** the name of the thing */
  label: string
  shortcut?: string
  /** one or two plain sentences: what it does and when to use it */
  desc?: string
  /** what to select first, for tools that work on a selection */
  select?: string
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}

/**
 * Tooltip: name, shortcut, a short description and what to select. Opens after a short hover or on keyboard focus. On touch
 * screens a long press shows it (and swallows the tap that would follow); a tap anywhere else puts it away.
 * Wraps a single child element. The Help setting "Show tooltips" turns every one of them off.
 */
export function Tip(props: TipProps) {
  const inside = useContext(HasProvider)
  return inside ? <TipInner {...props} /> : <TooltipProvider><TipInner {...props} /></TooltipProvider>
}

function TipInner({ label, shortcut, desc, select, children, side = 'bottom' }: TipProps) {
  const enabled = useSettings((s) => s.tooltips)
  const [open, setOpen] = useState(false)
  const held = useRef(false) // the tip was opened by a long press and stays until the next touch elsewhere
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const clearTimer = () => { clearTimeout(timer.current); start.current = null }

  useEffect(() => {
    if (!open || !held.current) return
    const away = () => { held.current = false; setOpen(false) }
    const id = setTimeout(() => window.addEventListener('pointerdown', away, true), 0)
    const auto = setTimeout(away, 6000)
    return () => { clearTimeout(id); clearTimeout(auto); window.removeEventListener('pointerdown', away, true) }
  }, [open])
  useEffect(() => clearTimer, [])

  if (!enabled) return <>{children}</>
  return (
    <T.Root open={open} onOpenChange={(o) => { if (!o && held.current) return; setOpen(o) }}>
      <T.Trigger
        asChild
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return
          fired.current = false
          start.current = { x: e.clientX, y: e.clientY }
          clearTimeout(timer.current)
          timer.current = setTimeout(() => { fired.current = true; held.current = true; setOpen(true) }, LONG_PRESS_MS)
        }}
        onPointerMove={(e) => {
          const s = start.current
          if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP) clearTimer()
        }}
        onPointerUp={clearTimer}
        onPointerCancel={clearTimer}
        onClickCapture={(e) => {
          // the finger lifting after a long press is not a tap on the control
          if (fired.current) { fired.current = false; e.stopPropagation(); e.preventDefault() }
        }}
        onContextMenu={(e) => { if (held.current || start.current) e.preventDefault() }}
      >
        {children}
      </T.Trigger>
      <T.Portal>
        <T.Content className={'tip' + (desc || select ? '' : ' plain')} side={side} sideOffset={5} collisionPadding={8} data-testid="tooltip">
          <div className="tip-head">
            <span className="tip-name">{label}</span>
            {shortcut && <span className="kbd">{shortcut}</span>}
          </div>
          {desc && <div className="tip-desc">{desc}</div>}
          {select && <div className="tip-sel"><span>Select</span> {select}</div>}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}

/** The usual tooltip of a command: its name, shortcut, description and selection hint. */
export function CmdTip({ cmd, children, side = 'bottom' }: { cmd: Pick<Command, 'id' | 'label' | 'tip' | 'shortcut'>; children: ReactNode; side?: TipProps['side'] }) {
  const h = helpFor(cmd)
  return <Tip label={cmd.label.replace(/^Create /, '')} shortcut={cmd.shortcut} desc={h?.desc} select={h?.select} side={side}>{children}</Tip>
}
