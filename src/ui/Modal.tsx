import { create } from 'zustand'
import type { ReactNode } from 'react'

/** Minimal centered dialog. */
export function Modal({ title, children, footer, width = 420, onClose }: { title: string; children: ReactNode; footer?: ReactNode; width?: number; onClose?: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 2000, display: 'grid', placeItems: 'center' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose?.() }}
    >
      <div style={{ width, maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-2)', border: '1px solid var(--line-strong)', borderRadius: 4, boxShadow: 'var(--shadow-float)' }}>
        <div className="panel-title" style={{ background: 'var(--bg-2)' }}>{title}</div>
        <div style={{ padding: 10, overflow: 'auto', fontSize: 'var(--fs-md)' }}>{children}</div>
        {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: 8, borderTop: '1px solid var(--line)' }}>{footer}</div>}
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
  return (
    <div style={{ position: 'fixed', bottom: 34, left: '50%', transform: 'translateX(-50%)', zIndex: 3000, padding: '6px 12px', background: 'var(--bg-3)', border: `1px solid ${kind === 'error' ? 'var(--danger)' : 'var(--line-strong)'}`, borderRadius: 3, boxShadow: 'var(--shadow-float)', fontSize: 'var(--fs-md)' }}>
      {msg}
    </div>
  )
}
