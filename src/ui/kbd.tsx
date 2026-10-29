/**
 * The on-screen keyboard for number boxes. On a touch screen a value box opens the numeric pad (inputmode="decimal"); the pad has
 * no letters (or, on iPhone, no minus sign), so a small key beside the box swaps it for the full keyboard for names like `width * 2`
 * and for negative numbers. On a computer nothing changes.
 */
import { useRef, useState, type RefObject } from 'react'
import { useDevice } from '@/app/device'

export type KbdMode = 'decimal' | 'text'

export function useKbd(initial: KbdMode = 'decimal') {
  const coarse = useDevice((s) => s.coarse)
  const [mode, setMode] = useState<KbdMode>(initial)
  /** true while the box is being refocused to switch keyboards: its blur must not count as "done typing" */
  const swapping = useRef(false)
  const toggle = (input: RefObject<HTMLInputElement | null> | HTMLInputElement | null) => {
    const el = input && 'current' in input ? input.current : input
    swapping.current = true
    setMode((m) => (m === 'decimal' ? 'text' : 'decimal'))
    requestAnimationFrame(() => {
      if (el) { el.blur(); el.focus() }
      swapping.current = false
    })
  }
  return { coarse, mode, inputMode: coarse ? mode : undefined, swapping, toggle }
}

/** The key that swaps the number pad and the full keyboard. Only rendered on touch screens. */
export function KbdToggle({ mode, onToggle }: { mode: KbdMode; onToggle: () => void }) {
  return (
    <button
      type="button" className="kbd-toggle" tabIndex={-1} aria-label={mode === 'decimal' ? 'Show the full keyboard' : 'Show the number pad'}
      // (the box keeps the focus, or the keyboard would close and open again)
      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation() }}
      onClick={onToggle}
    >
      {mode === 'decimal' ? 'abc' : '123'}
    </button>
  )
}
