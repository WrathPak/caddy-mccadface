import type { MouseEvent as RME, PointerEvent as RPE } from 'react'

/**
 * Buttons that must work on the first tap even with the on-screen keyboard up.
 *
 * With a number box focused, the first tap elsewhere hides the keyboard, the page resizes under the finger and the button the
 * finger was on has moved away by the time the browser decides what was clicked: the tap is lost, or lands on something else.
 * So on a touch screen the action runs when the finger lifts (before any of that), after the focused box has been left, which
 * commits what was typed in it. A finger that slid off the button first is not a tap. The click that follows is ignored; a mouse
 * or the keyboard use the plain click, as always.
 */
let fired: { el: EventTarget; at: number } | null = null

export function tapProps(fn: () => void) {
  return {
    onPointerUp: (e: RPE<HTMLElement>) => {
      if (e.pointerType !== 'touch') return
      const under = document.elementFromPoint(e.clientX, e.clientY)
      if (!under || !e.currentTarget.contains(under)) return
      const active = document.activeElement as HTMLElement | null
      if (active && active !== document.body && active !== e.currentTarget) active.blur?.()
      fired = { el: e.currentTarget, at: performance.now() }
      fn()
    },
    // (the handlers are made again on every render, so what happened on pointer-up is remembered outside them)
    onClick: (e: RME<HTMLElement>) => {
      if (fired && fired.el === e.currentTarget && performance.now() - fired.at < 800) { fired = null; return }
      fn()
    },
  }
}
