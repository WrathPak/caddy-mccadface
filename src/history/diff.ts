/** Compare two versions of a document: which features were added, removed, changed or moved, and what else differs. */

export interface SnapFeature { id: string; type: string; name: string; suppressed?: boolean; params: Record<string, unknown> }
export interface SnapDoc {
  name?: string
  features: SnapFeature[]
  rollback?: number
  userParams?: { name: string; expr: string }[]
  configs?: { name: string; values: Record<string, string> }[]
  activeConfig?: string | null
}

export interface FieldChange { key: string; from: unknown; to: unknown }
export type DiffKind = 'added' | 'removed' | 'changed' | 'moved'
export interface FeatureDiff {
  kind: DiffKind
  id: string
  type: string
  name: string
  /** what changed inside a 'changed' feature (name, suppressed state and each parameter) */
  changes: FieldChange[]
}
export interface DocDiff {
  features: FeatureDiff[]
  /** user parameters that were added, removed or given another expression */
  parameters: FieldChange[]
  /** other document-level differences (rollback marker, active configuration, configuration list) */
  other: FieldChange[]
  /** true when the two documents are the same */
  same: boolean
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The ids that keep their relative order between two orderings of the same ids (a longest common subsequence). */
function keptInOrder(x: string[], y: string[]): Set<string> {
  const n = x.length, m = y.length
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  const out = new Set<string>()
  for (let i = 0, j = 0; i < n && j < m;) {
    if (x[i] === y[j]) { out.add(x[i]); i++; j++ } else if (t[i + 1][j] >= t[i][j + 1]) i++
    else j++
  }
  return out
}

/** Parse a stored document.json snapshot. */
export function parseSnapshot(text: string): SnapDoc {
  const j = JSON.parse(text) as SnapDoc
  return { ...j, features: j.features ?? [] }
}

/** What changes going from version `a` to version `b`. */
export function diffDocs(a: SnapDoc, b: SnapDoc): DocDiff {
  const out: FeatureDiff[] = []
  const inA = new Map(a.features.map((f, i) => [f.id, { f, i }]))
  const inB = new Map(b.features.map((f, i) => [f.id, { f, i }]))
  for (const f of a.features) {
    if (!inB.has(f.id)) out.push({ kind: 'removed', id: f.id, type: f.type, name: f.name, changes: [] })
  }
  // order of the features both versions have: those outside the longest run that kept its order are the ones that moved
  const stays = keptInOrder(a.features.filter((f) => inB.has(f.id)).map((f) => f.id), b.features.filter((f) => inA.has(f.id)).map((f) => f.id))
  for (const f of b.features) {
    const old = inA.get(f.id)
    if (!old) { out.push({ kind: 'added', id: f.id, type: f.type, name: f.name, changes: [] }); continue }
    const changes: FieldChange[] = []
    if (old.f.name !== f.name) changes.push({ key: 'name', from: old.f.name, to: f.name })
    if (old.f.type !== f.type) changes.push({ key: 'type', from: old.f.type, to: f.type })
    if (!!old.f.suppressed !== !!f.suppressed) changes.push({ key: 'suppressed', from: !!old.f.suppressed, to: !!f.suppressed })
    const keys = new Set([...Object.keys(old.f.params ?? {}), ...Object.keys(f.params ?? {})])
    for (const k of [...keys].sort()) if (!same(old.f.params?.[k], f.params?.[k])) changes.push({ key: k, from: old.f.params?.[k], to: f.params?.[k] })
    if (changes.length) out.push({ kind: 'changed', id: f.id, type: f.type, name: f.name, changes })
    else if (!stays.has(f.id)) out.push({ kind: 'moved', id: f.id, type: f.type, name: f.name, changes: [] })
  }

  const parameters: FieldChange[] = []
  const pa = new Map((a.userParams ?? []).map((p) => [p.name, p.expr]))
  const pb = new Map((b.userParams ?? []).map((p) => [p.name, p.expr]))
  for (const k of new Set([...pa.keys(), ...pb.keys()])) if (pa.get(k) !== pb.get(k)) parameters.push({ key: k, from: pa.get(k), to: pb.get(k) })

  const other: FieldChange[] = []
  if ((a.rollback ?? a.features.length) !== (b.rollback ?? b.features.length)) other.push({ key: 'rollback', from: a.rollback, to: b.rollback })
  if ((a.activeConfig ?? null) !== (b.activeConfig ?? null)) other.push({ key: 'activeConfig', from: a.activeConfig ?? null, to: b.activeConfig ?? null })
  if (!same(a.configs ?? [], b.configs ?? [])) other.push({ key: 'configs', from: (a.configs ?? []).map((c) => c.name), to: (b.configs ?? []).map((c) => c.name) })
  if (a.name !== b.name) other.push({ key: 'name', from: a.name, to: b.name })

  return { features: out, parameters, other, same: !out.length && !parameters.length && !other.length }
}

/** Short text for a value in a diff line. */
export function shown(v: unknown): string {
  if (v === undefined) return '(none)'
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 37) + '...' : v || '(empty)'
  const s = JSON.stringify(v)
  return s.length > 40 ? s.slice(0, 37) + '...' : s
}
