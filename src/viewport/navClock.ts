/**
 * Clock for the camera animations and inertia. It is just performance.now() in the app. The e2e specs can freeze it and step it
 * by hand (through the dev-only debug handle) so a slow software renderer can't skip over an animation.
 */
let frozenAt: number | null = null
let offset = 0

export const navClock = {
  now: () => (frozenAt ?? performance.now() + offset),
  isFrozen: () => frozenAt !== null,
  /** Stop the clock: time only moves through advance(). */
  freeze() {
    if (frozenAt === null) frozenAt = performance.now() + offset
  },
  /** Start the clock again from where it was frozen. */
  unfreeze() {
    if (frozenAt !== null) {
      offset = frozenAt - performance.now()
      frozenAt = null
    }
  },
  /** Move the clock forward by ms. */
  advance(ms: number) {
    if (frozenAt !== null) frozenAt += ms
    else offset += ms
  },
}
