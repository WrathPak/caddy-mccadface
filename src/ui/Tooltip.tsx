import * as T from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <T.Provider delayDuration={450} skipDelayDuration={200}>
    {children}
  </T.Provider>
)

/** Tooltip with optional shortcut hint. Wraps a single child element. */
export function Tip({ label, shortcut, children, side = 'bottom' }: {
  label: string
  shortcut?: string
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content className="tip" side={side} sideOffset={5}>
          <span>{label}</span>
          {shortcut && <span className="kbd">{shortcut}</span>}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
