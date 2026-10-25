/**
 * Completion for the Script panel's editor: type `caddy.` and the members of the API are offered, with their signatures.
 * The list mirrors caddy-api.d.ts (a unit test checks every entry exists there), which is the full reference.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'

export const API_OUTLINE: [path: string, detail: string][] = [
  ['caddy.version', "'1'"],
  ['caddy.log.log', '(...args): void'],
  ['caddy.log.info', '(...args): void'],
  ['caddy.log.warn', '(...args): void'],
  ['caddy.log.error', '(...args): void'],
  ['caddy.features.register', '(def: CaddyFeatureDefinition): void'],
  ['caddy.commands.register', '(def: CaddyCommandDefinition): void'],
  ['caddy.commands.run', '(id: string): Promise<void>'],
  ['caddy.ribbon.add', '({ command, tab?, group? }): void'],
  ['caddy.document.info', '(): Promise<{ name, featureCount, rollback, dirty }>'],
  ['caddy.document.features', '(): Promise<CaddyFeatureInfo[]>'],
  ['caddy.document.bodies', '(): Promise<CaddyBodyInfo[]>'],
  ['caddy.document.userParams', '(): Promise<{ name, expr }[]>'],
  ['caddy.document.addFeature', '(type, params, name?): Promise<string>'],
  ['caddy.document.updateFeature', '(id, params): Promise<void>'],
  ['caddy.document.removeFeature', '(id): Promise<void>'],
  ['caddy.document.onChange', '(callback): CaddyDisposable'],
  ['caddy.selection.get', '(): Promise<CaddySelectionRef[]>'],
  ['caddy.selection.set', '(refs): Promise<void>'],
  ['caddy.selection.onChange', '(callback): CaddyDisposable'],
  ['caddy.kernel.box', '({ size, position? }): Promise<CaddyBody>'],
  ['caddy.kernel.cylinder', '({ radius, height, position? }): Promise<CaddyBody>'],
  ['caddy.kernel.sphere', '({ radius, center? }): Promise<CaddyBody>'],
  ['caddy.kernel.extrude', '({ outline, holes?, height, plane?, origin? }): Promise<CaddyBody>'],
  ['caddy.kernel.boolean', "({ op: 'union' | 'subtract' | 'intersect', base, tools }): Promise<CaddyBody>"],
  ['caddy.kernel.transform', '({ body, translate?, rotate?, scale?, pivot? }): Promise<CaddyBody>'],
  ['caddy.kernel.toMesh', '(body): Promise<CaddyBody>'],
  ['caddy.kernel.triangles', '(body): Promise<CaddyMeshData>'],
  ['caddy.kernel.mesh.fromTriangles', '({ positions, indices? }): Promise<CaddyBody>'],
  ['caddy.kernel.mesh.boolean', '({ op, base, tools }): Promise<CaddyBody>'],
  ['caddy.kernel.mesh.booleanMany', '(jobs): Promise<CaddyBody[]>'],
  ['caddy.io.download', '(name, data, mime?): Promise<void>'],
  ['caddy.ui.toast', "(message, kind?: 'info' | 'error'): void"],
]

interface Node { children: Map<string, Node>; detail?: string }

function tree(): Node {
  const root: Node = { children: new Map() }
  for (const [path, detail] of API_OUTLINE) {
    let n = root
    for (const part of path.split('.')) {
      let c = n.children.get(part)
      if (!c) { c = { children: new Map() }; n.children.set(part, c) }
      n = c
    }
    n.detail = detail
  }
  return root
}
const ROOT = tree()

/** The names offered after `path.` (for example 'caddy.kernel'), or none when the path is not part of the API. */
export function membersOf(path: string): Completion[] {
  let n: Node | undefined = ROOT
  for (const part of path.split('.')) n = n?.children.get(part)
  if (!n) return []
  return [...n.children.entries()].map(([name, c]) => ({
    label: name,
    type: c.children.size ? 'namespace' : c.detail?.startsWith('(') ? 'method' : 'property',
    detail: c.detail,
  }))
}

export function caddyCompletions(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/\bcaddy(?:\.\w+)*\.\w*$/)
  if (!m) return null
  const text = m.text
  const cut = text.lastIndexOf('.')
  const options = membersOf(text.slice(0, cut))
  if (!options.length) return null
  return { from: m.from + cut + 1, options, validFor: /^\w*$/ }
}

/** `ctx.kernel.` inside a compute function offers the kernel as well. */
export function kernelCompletions(ctx: CompletionContext): CompletionResult | null {
  const m = ctx.matchBefore(/\b(?:ctx|context)\.kernel(?:\.mesh)?\.\w*$/)
  if (!m) return null
  const cut = m.text.lastIndexOf('.')
  const options = membersOf('caddy.' + m.text.slice(m.text.indexOf('.') + 1, cut))
  return options.length ? { from: m.from + cut + 1, options, validFor: /^\w*$/ } : null
}
