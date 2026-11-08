/**
 * Commands wait here while a reload is still putting things back (the kernel making the bodies again, the sketch or dialog being
 * reopened): a tool started a moment too early would meet a model that is not there yet. It is closed for a second or so after a reload
 * and never otherwise. View commands do not wait.
 */
let closed = 0
const waiters = new Set<() => void>()

export const gateClosed = () => closed > 0

/** Close the gate; the returned function opens it again (every close needs its open). */
export function closeGate(): () => void {
  closed++
  let done = false
  return () => {
    if (done) return
    done = true
    if (--closed > 0) return
    const run = [...waiters]
    waiters.clear()
    run.forEach((f) => f())
  }
}

/** Run `fn` when the gate is open (at once if it is). */
export function whenGateOpens(fn: () => void) {
  if (closed === 0) fn()
  else waiters.add(fn)
}
