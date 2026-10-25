/** What is worth an autosave, and what is worth offering back after a crash. */
import type { DocData } from '@/doc/types'

/** True when a document holds anything: a feature, or a component. A new, empty document has nothing to lose. */
export const hasContent = (d: Pick<DocData, 'features' | 'assembly'>) => d.features.length > 0 || d.assembly.occurrences.length > 0

/** Autosave only real unsaved edits: changed since the last save / open (or new) AND not empty. */
export const shouldAutosave = (s: Pick<DocData, 'features' | 'assembly'> & { dirty: boolean }) => s.dirty && hasContent(s)

/** An autosaved copy is offered back only when it has something in it. */
export const worthRecovering = (data: Pick<DocData, 'features' | 'assembly'>) => hasContent(data)
