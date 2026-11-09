/** A short signature of everything that decides what a regeneration produces, for telling a kept result from a stale one. */
import type { DocData } from './types'

export function hashString(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36) + s.length.toString(36)
}

/**
 * The build the page runs: the file name of the entry script (Vite puts a content hash in it), so geometry kept by an older build is
 * never shown as if the new one had made it. Constant in dev and in unit tests.
 */
export function codeStamp(): string {
  try {
    const s = document.querySelector('script[type="module"][src]') as HTMLScriptElement | null
    return s ? new URL(s.src).pathname : 'dev'
  } catch { return 'dev' }
}

type SigInput = Pick<DocData, 'features' | 'rollback' | 'userParams' | 'configs' | 'activeConfig' | 'assembly'> & { blobs: Record<string, unknown> }

/**
 * What the bodies of a document depend on: the timeline (type, parameters, suppression, component of each feature), the rollback
 * marker, the parameters and configurations, the components, and which import sources it holds. Names, status and the undo stacks do not matter.
 */
export function docSig(d: SigInput, stamp: string = codeStamp()): string {
  const features = d.features.map((f) => [f.id, f.type, f.suppressed, f.component ?? '', f.params])
  return hashString(JSON.stringify([stamp, features, d.rollback, d.userParams, d.configs, d.activeConfig, d.assembly, Object.keys(d.blobs).sort()]))
}
