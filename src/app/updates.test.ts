import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const events: string[] = []
vi.mock('@/io/actions', () => ({ flushAutosave: vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); events.push('saved') }) }))

import { applyUpdate, markUpdateReady, setUpdater, useUpdate, watchForUpdates } from './updates'

beforeEach(() => {
  events.length = 0
  useUpdate.setState({ ready: false, switched: false, applying: false })
  setUpdater(null)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('update button', () => {
  it('shows only once a new version is waiting', () => {
    expect(useUpdate.getState().ready).toBe(false)
    markUpdateReady()
    expect(useUpdate.getState().ready).toBe(true)
  })

  it('saves and waits for the save before it switches versions', async () => {
    setUpdater(async (reload) => { events.push(`update(${reload})`) })
    markUpdateReady()
    await applyUpdate()
    expect(events).toEqual(['saved', 'update(true)'])
  })

  it('a second click while it is working does nothing', async () => {
    setUpdater(async () => { events.push('update') })
    const a = applyUpdate()
    void applyUpdate()
    await a
    expect(events).toEqual(['saved', 'update'])
  })

  it('does not strand the button when the update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setUpdater(async () => { throw new Error('boom') })
    await applyUpdate()
    expect(useUpdate.getState().applying).toBe(false)
  })
})

describe('update checks', () => {
  function fakeDoc() {
    const l: Record<string, (() => void)[]> = {}
    const doc = {
      visibilityState: 'visible',
      addEventListener: (t: string, f: () => void) => { (l[t] ??= []).push(f) },
      removeEventListener: (t: string, f: () => void) => { l[t] = (l[t] ?? []).filter((x) => x !== f) },
    }
    return { doc, fire: (t: string) => (l[t] ?? []).forEach((f) => f()), count: (t: string) => (l[t] ?? []).length }
  }

  it('checks about every hour, and not before', async () => {
    vi.useFakeTimers()
    const d = fakeDoc()
    vi.stubGlobal('document', d.doc)
    const update = vi.fn(async () => {})
    const stop = watchForUpdates({ update })
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000)
    expect(update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(61 * 1000)
    expect(update).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(update).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(update).toHaveBeenCalledTimes(2)
    expect(d.count('visibilitychange')).toBe(0)
  })

  it('checks when someone comes back to the tab, but not in a rush', async () => {
    let t = 1_000_000
    const d = fakeDoc()
    vi.stubGlobal('document', d.doc)
    const update = vi.fn(async () => {})
    watchForUpdates({ update }, { now: () => t, everyMs: 2e9 })
    d.doc.visibilityState = 'hidden'
    d.fire('visibilitychange')
    d.doc.visibilityState = 'visible'
    t += 60_000
    d.fire('visibilitychange') // a minute: too soon
    expect(update).not.toHaveBeenCalled()
    t += 5 * 60_000
    d.fire('visibilitychange')
    expect(update).toHaveBeenCalledTimes(1)
    d.fire('visibilitychange') // just checked
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('a failing check (offline, server down) is swallowed', async () => {
    let t = 0
    const d = fakeDoc()
    vi.stubGlobal('document', d.doc)
    const update = vi.fn(async () => { throw new Error('offline') })
    watchForUpdates({ update }, { now: () => t, everyMs: 2e9, gapMs: 0 })
    t += 1
    d.fire('visibilitychange')
    await Promise.resolve()
    expect(update).toHaveBeenCalled()
  })
})
