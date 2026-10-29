import * as Dialog from '@radix-ui/react-dialog'
import { X } from '@phosphor-icons/react'
import type { ReactNode } from 'react'

export type NavItem = { heading: string } | { id: string; label: string }

/**
 * A dialog with a list of pages on the left and the page on the right (Settings, Help). Under 700 px wide it fills the screen and
 * the list becomes a strip of buttons above the page, so there is a single column.
 */
export function SplitDialog({ open, onOpenChange, title, description, nav, active, onSelect, children, testId, footer }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  nav: NavItem[]
  active: string
  onSelect: (id: string) => void
  children: ReactNode
  testId: string
  footer?: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-overlay" />
        <Dialog.Content className="dlg" data-help-dialog data-testid={testId} aria-describedby="dlg-desc">
          <div className="dlg-head">
            <Dialog.Title className="dlg-title">{title}</Dialog.Title>
            <Dialog.Description id="dlg-desc" className="dlg-desc">{description}</Dialog.Description>
            <Dialog.Close className="dlg-close" aria-label={`Close ${title.toLowerCase()}`}><X size={14} /></Dialog.Close>
          </div>
          <div className="dlg-body">
            <nav className="dlg-nav" aria-label={`${title} sections`}>
              {nav.map((n, i) =>
                'heading' in n ? (
                  <div key={'h' + i} className="dlg-nav-head">{n.heading}</div>
                ) : (
                  <button key={n.id} type="button" className="dlg-nav-item" data-active={n.id === active} data-testid={`${testId}-nav-${n.id}`} aria-current={n.id === active ? 'page' : undefined} onClick={() => onSelect(n.id)}>
                    {n.label}
                  </button>
                ),
              )}
            </nav>
            <div className="dlg-pane" data-testid={`${testId}-pane`}>{children}</div>
          </div>
          {footer && <div className="dlg-foot">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
