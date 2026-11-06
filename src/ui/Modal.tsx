import { create } from 'zustand'
import { useEffect, useRef, type ReactNode } from 'react'

/** Minimal centered dialog. */
export function Modal({ title, children, footer, width = 420, onClose }: { title: string; children: ReactNode; footer?: ReactNode; width?: number; onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    // Escape closes the dialog wherever the focus is; focus moves into the dialog so the keyboard works at once
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeRef.current?.()
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      prev?.focus?.()
    }
  }, [])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="modal-scrim"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="modal" style={{ width }}>
        <div className="panel-title">{title}</div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

interface ToastState { msg: string | null; kind: 'info' | 'error'; show: (m: string, k?: 'info' | 'error') => void }
let timer: ReturnType<typeof setTimeout> | undefined
export const useToast = create<ToastState>((set) => ({
  msg: null,
  kind: 'info',
  show: (msg, kind = 'info') => {
    set({ msg, kind })
    clearTimeout(timer)
    timer = setTimeout(() => set({ msg: null }), kind === 'error' ? 6000 : 3000)
  },
}))
export const toast = (m: string, k: 'info' | 'error' = 'info') => useToast.getState().show(m, k)

export function Toast() {
  const { msg, kind } = useToast()
  if (!msg) return null
  return <div className={'toast' + (kind === 'error' ? ' error' : '')} role="status">{msg}</div>
}
