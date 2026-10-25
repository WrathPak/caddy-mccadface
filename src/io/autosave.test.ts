import { describe, expect, it } from 'vitest'
import { emptyAssembly } from '@/assembly/types'
import { hasContent, shouldAutosave, worthRecovering } from './autosave'

const empty = { features: [], assembly: emptyAssembly() }
const withFeature = { features: [{ id: 'f1' }] as never, assembly: emptyAssembly() }
const withComponent = { features: [], assembly: { ...emptyAssembly(), occurrences: [{ id: 'o1' }] as never } }

describe('autosave', () => {
  it('saves only real unsaved edits', () => {
    expect(shouldAutosave({ ...withFeature, dirty: true })).toBe(true)
    expect(shouldAutosave({ ...withComponent, dirty: true })).toBe(true)
    // unchanged since the last save or open: nothing to keep
    expect(shouldAutosave({ ...withFeature, dirty: false })).toBe(false)
    // edited but empty again (everything undone or deleted): nothing to lose
    expect(shouldAutosave({ ...empty, dirty: true })).toBe(false)
  })

  it('offers back only a copy that has something in it', () => {
    expect(worthRecovering(empty)).toBe(false)
    expect(worthRecovering(withFeature)).toBe(true)
    expect(hasContent(withComponent)).toBe(true)
  })
})
