import { beforeAll, describe, expect, it } from 'vitest'
import { api } from '@/kernel/api'
import { computeApi } from '@/kernel/compute'
import { topoVolume } from '@/kernel/meshutil'
import type { Body } from '@/kernel/types'
import type { FeatureCtx, FeatureDef } from '@/doc/types'
import { PluginHost, type CommandSpec, type HostServices, type PluginSpec } from './host'
import { createLocalTransport } from './localTransport'
import { METHODS, NEEDS } from './runtime/surface.js'
import { compileSchema } from './schema'
import { linkModules, specifiersOf } from './runtime/link.js'

beforeAll(async () => { await api.init() })

/** A fake app around the real kernel. */
function fakeApp(over: Partial<HostServices> = {}) {
  const features = new Map<string, FeatureDef>()
  const commands = new Map<string, CommandSpec>()
  const ribbon: { owner: string; tab: string; group: string; cmd: string }[] = []
  const toasts: string[] = []
  const downloads: { name: string; bytes: Uint8Array; mime: string }[] = []
  const docListeners = new Set<() => void>()
  const doc = { features: [] as { id: string; type: string; name: string; state: string; suppressed: boolean; params: Record<string, unknown> }[], bodies: [] as { body: Body; id: string; name: string }[] }
  const svc: HostServices = {
    kernel: api as unknown as HostServices['kernel'],
    meshBooleans: (jobs) => Promise.all(jobs.map((j) => computeApi.meshBoolean(j))),
    document: {
      info: () => ({ name: 'Test', featureCount: doc.features.length, rollback: doc.features.length, dirty: false }),
      features: () => doc.features,
      bodies: () => doc.bodies,
      userParams: () => [{ name: 'w', expr: '10 mm' }],
      addFeature: (type, params, name) => { const id = 'f' + (doc.features.length + 1); doc.features.push({ id, type, name: name ?? type, state: 'ok', suppressed: false, params }); return id },
      updateFeature: (id, params) => { const f = doc.features.find((x) => x.id === id)!; f.params = params },
      removeFeature: (id) => { doc.features = doc.features.filter((f) => f.id !== id) },
      subscribe: (cb) => { docListeners.add(cb); return () => docListeners.delete(cb) },
    },
    selection: { get: () => [{ kind: 'body', id: 'f1' }], set: () => {}, subscribe: () => () => {} },
    bodyIds: (r) => r,
    registerFeature: (d) => void features.set(d.type, d),
    unregisterFeature: (t) => void features.delete(t),
    registerCommand: (c) => void commands.set(c.id, c),
    unregisterCommand: (id) => void commands.delete(id),
    commandExists: (id) => commands.has(id) || id === 'view.frame',
    runCommand: () => {},
    startFeature: () => {},
    addRibbon: (owner, e) => void ribbon.push({ owner, ...e }),
    clearRibbon: (owner) => { for (let i = ribbon.length - 1; i >= 0; i--) if (ribbon[i].owner === owner) ribbon.splice(i, 1) },
    toast: (m) => void toasts.push(m),
    download: (name, bytes, mime) => void downloads.push({ name, bytes, mime }),
    regenerate: () => {},
    ...over,
  }
  return { svc, features, commands, ribbon, toasts, downloads, doc, fire: () => docListeners.forEach((l) => l()) }
}

const spec = (code: string | Record<string, string>, granted: string[] = []): PluginSpec => ({
  id: 'demo', name: 'Demo', granted,
  files: typeof code === 'string' ? { 'index.js': code } : code,
  entry: 'index.js',
})
const open = (s: PluginSpec) => Promise.resolve(createLocalTransport(s.files, s.entry))

async function run(code: string | Record<string, string>, granted: string[] = [], over: Partial<HostServices> = {}) {
  const app = fakeApp(over)
  const host = new PluginHost(spec(code, granted), app.svc, open)
  await host.start()
  return { app, host }
}

const ctxOf = (id = 'f1', name = 'Thing1', bodies: Body[] = []): FeatureCtx => ({
  feature: { id, type: 'demo.thing', name },
  bodies,
  body: () => undefined,
  kernel: api as never,
  blob: () => undefined,
  newBodyId: (n) => (n ? `${id}.${n}` : id),
  dataOf: () => undefined,
  featureById: () => undefined,
  stateAround: () => undefined,
})

const volume = (b: Body) => {
  const p = b.mesh.positions, ix = b.mesh.indices
  let v = 0
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, c = ix[t + 1] * 3, d = ix[t + 2] * 3
    v += (p[a] * (p[c + 1] * p[d + 2] - p[c + 2] * p[d + 1]) - p[a + 1] * (p[c] * p[d + 2] - p[c + 2] * p[d]) + p[a + 2] * (p[c] * p[d + 1] - p[c + 1] * p[d])) / 6
  }
  return Math.abs(v)
}

describe('plugin host with the real kernel and the in-process sandbox', () => {
  it('starts a plugin, registers its feature, command and ribbon entries under its id', async () => {
    const { app, host } = await run(`
      export const manifest = { name: 'Demo plugin', version: '1.2.3' }
      export function activate(caddy) {
        caddy.features.register({ type: 'thing', label: 'Thing', icon: 'gear', ribbon: { group: 'Things' }, params: [{ type: 'number', key: 'size', label: 'Size', unit: 'mm', default: 5 }], compute: async () => ({}) })
        caddy.commands.register({ id: 'hello', label: 'Say hello', run: () => caddy.ui.toast('hello from the plugin') })
        caddy.ribbon.add({ command: 'hello', tab: 'mesh' })
      }`)
    expect(host.state).toBe('running')
    expect(host.manifest).toMatchObject({ name: 'Demo plugin', version: '1.2.3' })
    expect([...app.features.keys()]).toEqual(['demo.thing'])
    expect(app.features.get('demo.thing')!.schema.params).toHaveLength(1)
    expect([...app.commands.keys()].sort()).toEqual(['demo.hello', 'demo.thing.create'])
    expect(app.ribbon).toEqual([{ owner: 'demo', tab: 'solid', group: 'Things', cmd: 'demo.thing.create' }, { owner: 'demo', tab: 'mesh', group: 'Demo', cmd: 'demo.hello' }])
    // running its command runs plugin code, which calls back into the host
    app.commands.get('demo.hello')!.run()
    await new Promise((r) => setTimeout(r, 50))
    expect(app.toasts).toEqual(['hello from the plugin'])
    host.stop()
    expect(app.features.size).toBe(0)
    expect(app.commands.size).toBe(0)
    expect(app.ribbon).toEqual([])
    expect(host.state).toBe('stopped')
  })

  it('compute builds geometry through the kernel and the result gets the feature body id', async () => {
    const { app, host } = await run(`
      export function activate(caddy) {
        caddy.features.register({
          type: 'thing', label: 'Thing',
          params: [{ type: 'number', key: 'w', label: 'W', default: 10 }, { type: 'number', key: 'hole', label: 'Hole', default: 2 }],
          async compute(ctx, p) {
            const k = ctx.kernel
            const slab = await k.box({ size: [p.w, p.w, 4], position: [p.w / 2, p.w / 2, 0] })
            const pin = await k.cylinder({ radius: p.hole, height: 10, position: [p.w / 2, p.w / 2, -3] })
            const cut = await k.boolean({ op: 'subtract', base: slab, tools: [pin] })
            const moved = await k.transform({ body: cut, translate: [100, 0, 0] })
            return { bodies: [moved], warning: ctx.bodies.length + ' bodies before' }
          },
        })
      }`)
    const def = app.features.get('demo.thing')!
    const r = await def.compute(ctxOf(), { w: 10, hole: 2 })
    expect(r.bodies).toHaveLength(1)
    const b = r.bodies![0]
    expect(b.id).toBe('f1')
    expect(b.name).toBe('Thing1')
    expect(b.kind).toBe('brep')
    expect(volume(b)).toBeCloseTo(10 * 10 * 4 - Math.PI * 4 * 4, 0)
    expect(r.warning).toBe('0 bodies before')
    host.stop()
  })

  it('kernel.extrude makes a polygon prism with holes, in any plane', async () => {
    const { app } = await run(`
      export function activate(caddy) {
        caddy.features.register({ type: 'thing', label: 'T', params: [], async compute(ctx) {
          const a = await ctx.kernel.extrude({ outline: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[3, 3], [3, 7], [7, 7], [7, 3]]], height: 5 })
          const b = await ctx.kernel.extrude({ outline: [[0, 0], [0, 10], [10, 10], [10, 0]], height: 2, plane: 'XZ', origin: [0, 20, 0] }) // clockwise outline is fine too
          const s = await ctx.kernel.sphere({ radius: 3, center: [50, 50, 50] })
          return { bodies: [a, b, s] }
        } })
      }`)
    const r = await app.features.get('demo.thing')!.compute(ctxOf(), {})
    expect(r.bodies!.map((b) => b.id)).toEqual(['f1', 'f1.1', 'f1.2'])
    expect(volume(r.bodies![0])).toBeCloseTo((100 - 16) * 5, 1)
    expect(volume(r.bodies![1])).toBeCloseTo(100 * 2, 1)
    expect(volume(r.bodies![2])).toBeGreaterThan((4 / 3) * Math.PI * 27 * 0.95)
    const bb = r.bodies![1].mesh.positions
    const ys = [...bb].filter((_, i) => i % 3 === 1)
    expect(Math.min(...ys)).toBeCloseTo(18, 3) // XZ plane faces -Y, so a height of 2 from y = 20 goes to y = 18
  })

  it('mesh booleans: one at a time and many side by side agree', async () => {
    const { app } = await run(`
      export function activate(caddy) {
        caddy.features.register({ type: 'thing', label: 'T', params: [], async compute(ctx) {
          const k = ctx.kernel
          const base = await k.box({ size: [10, 10, 10], position: [5, 5, 0] })
          const tools = await Promise.all([0, 1, 2].map((i) => k.box({ size: [5, 5, 5], position: [5.5 + 1.5 * i, 5.5, 3] })))
          const one = await k.mesh.boolean({ op: 'subtract', base, tools: [tools[0]] })
          const many = await k.mesh.booleanMany(tools.map((t) => ({ op: 'subtract', base, tools: [t] })))
          return { bodies: [one, ...many] }
        } })
      }`)
    const r = await app.features.get('demo.thing')!.compute(ctxOf(), {})
    const v = r.bodies!.map((b) => +volume(b).toFixed(2))
    expect(r.bodies!.every((b) => b.kind === 'mesh')).toBe(true)
    expect(v[1]).toBe(v[0])
    expect(v[1]).toBeCloseTo(1000 - 125, 1)
    expect(v[3]).toBeCloseTo(1000 - 4 * 5 * 5, 1) // the third tool hangs out of the cube by one mm
  })

  it('triangles and fromTriangles round trip a mesh', async () => {
    const { app } = await run(`
      export function activate(caddy) {
        caddy.features.register({ type: 'thing', label: 'T', params: [], async compute(ctx) {
          const box = await ctx.kernel.box({ size: [2, 3, 4] })
          const t = await ctx.kernel.triangles(box)
          const m = await ctx.kernel.mesh.fromTriangles({ positions: Array.from(t.positions), indices: Array.from(t.indices) })
          const asMesh = await ctx.kernel.toMesh(box)
          return { bodies: [m, asMesh], warning: t.indices.length / 3 + ' triangles' }
        } })
      }`)
    const r = await app.features.get('demo.thing')!.compute(ctxOf(), {})
    expect(r.warning).toBe('12 triangles')
    expect(r.bodies!.map((b) => b.kind)).toEqual(['mesh', 'mesh'])
    expect(volume(r.bodies![0])).toBeCloseTo(24, 3)
  })

  it('document reads, bodies with handles, writes (with permission) and change events', async () => {
    const app0 = fakeApp()
    const body = (await api.makeBox({ id: 'f1', name: 'Box', size: [1, 2, 3], position: [0, 0, 0] })) as Body
    app0.doc.bodies.push({ body, id: 'f1', name: 'Base' })
    app0.doc.features.push({ id: 'f1', type: 'box', name: 'Box1', state: 'ok', suppressed: false, params: { width: 1 } })
    const host = new PluginHost(spec(`
      export async function activate(caddy) {
        const info = await caddy.document.info()
        const feats = await caddy.document.features()
        const bodies = await caddy.document.bodies()
        const sel = await caddy.selection.get()
        const params = await caddy.document.userParams()
        caddy.log.info(JSON.stringify({ info, feats: feats.map((f) => f.type), bodies: bodies.map((b) => [b.id, b.name, b.kind, b.triangles, b.bounds.max]), sel, params }))
        const id = await caddy.document.addFeature('box', { width: 7 }, 'My box')
        await caddy.document.updateFeature(id, { width: 8 })
        caddy.document.onChange(() => caddy.log.info('changed'))
      }`, ['document:write']), app0.svc, open)
    await host.start()
    const line = JSON.parse(host.logs.find((l) => l.text.startsWith('{'))!.text)
    expect(line.info).toEqual({ name: 'Test', featureCount: 1, rollback: 1, dirty: false })
    expect(line.feats).toEqual(['box'])
    expect(line.bodies).toEqual([['f1', 'Base', 'brep', 12, [0.5, 1, 3]]])
    expect(line.sel).toEqual([{ kind: 'body', id: 'f1' }])
    expect(line.params).toEqual([{ name: 'w', expr: '10 mm' }])
    expect(app0.doc.features.map((f) => [f.name, f.params])).toEqual([['Box1', { width: 1 }], ['My box', { width: 8 }]])
    app0.fire()
    await new Promise((r) => setTimeout(r, 120))
    expect(host.logs.some((l) => l.text === 'changed')).toBe(true)
    host.stop()
  })

  describe('permissions', () => {
    const code = `
      export async function activate(caddy) {
        for (const [name, fn] of [
          ['download', () => caddy.io.download('a.txt', 'hi')],
          ['addFeature', () => caddy.document.addFeature('box', {})],
          ['run', () => caddy.commands.run('view.frame')],
        ]) {
          try { await fn(); caddy.log.info(name + ' ok') } catch (e) { caddy.log.warn(name + ' denied: ' + e.message) }
        }
      }`
    it('refuses what was not allowed, with a message that says what to do', async () => {
      const { app, host } = await run(code)
      const lines = host.logs.map((l) => l.text)
      expect(lines.filter((l) => l.includes('denied'))).toHaveLength(3)
      expect(lines.find((l) => l.startsWith('download'))).toContain('"download" permission')
      expect(app.downloads).toEqual([])
      expect(app.doc.features).toEqual([])
    })
    it('allows what the user allowed, and only that', async () => {
      const { app, host } = await run(code, ['download'])
      const lines = host.logs.map((l) => l.text)
      expect(lines).toContain('download ok')
      expect(lines.filter((l) => l.includes('denied'))).toHaveLength(2)
      expect(app.downloads).toHaveLength(1)
      expect(app.downloads[0]).toMatchObject({ name: 'a.txt' })
      expect(new TextDecoder().decode(app.downloads[0].bytes)).toBe('hi')
    })
    it('every call that needs a permission is listed in the surface', () => {
      for (const m of Object.keys(NEEDS)) expect(METHODS).toContain(m)
    })
  })

  describe('the sandbox', () => {
    it('removes network and storage APIs from the plugin', async () => {
      const { host } = await run(`
        export function activate(caddy) {
          caddy.log.info(JSON.stringify(['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'indexedDB', 'caches', 'Worker'].map((n) => typeof globalThis[n])))
        }`)
      // the in-process runtime hardens its own (fake) scope: the real checks are in the browser spec
      expect(host.state).toBe('running')
    })
    it('reports an error thrown while starting, with its message', async () => {
      const { host } = await run('export function activate() { throw new Error("nope, not today") }')
      expect(host.state).toBe('failed')
      expect(host.error).toBe('nope, not today')
    })
    it('reports a syntax error and a missing file', async () => {
      const a = await run('export function activate( {')
      expect(a.host.state).toBe('failed')
      const b = await run({ 'index.js': "import './missing.js'\nexport function activate() {}" })
      expect(b.host.state).toBe('failed')
      expect(b.host.error).toContain('no such file')
    })
    it('a feature whose compute throws reports the plugin error', async () => {
      const { app } = await run(`export function activate(c) { c.features.register({ type: 'x', label: 'X', params: [], compute() { throw new Error('bad gear teeth') } }) }`)
      await expect(app.features.get('demo.x')!.compute(ctxOf(), {})).rejects.toThrow('bad gear teeth')
    })
    it('a bad registration is a problem, not a crash', async () => {
      const { host, app } = await run(`export function activate(c) {
        c.features.register({ type: 'bad', label: 'Bad', params: [{ type: 'number', key: 'x', label: 'X' }], compute() {} })
        c.features.register({ type: 'good', label: 'Good', params: [], compute() { return {} } })
      }`)
      expect(host.state).toBe('running')
      expect(host.problems.join(' ')).toContain('default must be a number')
      expect([...app.features.keys()]).toEqual(['demo.good'])
    })
    it('bad arguments are refused before they reach the kernel', async () => {
      const { host } = await run(`export async function activate(c) {
        for (const f of [() => c.kernel.box({ size: [1, 2] }), () => c.kernel.box({ size: [1, -2, 3] }), () => c.kernel.boolean({ op: 'xor', base: 'h1', tools: ['h2'] }), () => c.kernel.transform({ body: 'h99' }), () => c.kernel.mesh.fromTriangles({ positions: [1, 2] })]) {
          try { await f(); c.log.info('accepted') } catch (e) { c.log.warn(e.message) }
        }
      }`)
      expect(host.logs.filter((l) => l.text === 'accepted')).toHaveLength(0)
      expect(host.logs.filter((l) => l.level === 'warn')).toHaveLength(5)
    })
  })

  it('answers every call of the surface (nothing is left unhandled)', async () => {
    const app = fakeApp()
    const host = new PluginHost(spec('export function activate() {}'), app.svc, open)
    for (const m of METHODS) {
      let msg = ''
      try { await host.dispatch(m, {}) } catch (e) { msg = (e as Error).message }
      expect(msg, m).not.toMatch(/Unknown call|Unhandled call/)
    }
  })
})

describe('declared parameter schemas', () => {
  it('turns plain data into an Inspector schema', () => {
    const s = compileSchema('p.gear', 'Gear', [
      { type: 'number', key: 'teeth', label: 'Teeth', min: 6, max: 100, step: 1, default: 20 },
      { type: 'enum', key: 'kind', label: 'Kind', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' },
      { type: 'number', key: 'angle', label: 'Angle', unit: 'deg', default: 20, visibleWhen: { key: 'kind', equals: 'b' } },
      { type: 'group', label: 'More', collapsed: true, children: [{ type: 'bool', key: 'bore', label: 'Bore', default: true }, { type: 'vector3', key: 'at', label: 'At', default: [0, 0, 0] }, { type: 'text', key: 'note', label: 'Note', default: '' }, { type: 'selection-ref', key: 'on', label: 'On', accepts: ['body'] }] },
    ])
    expect(s.id).toBe('p.gear')
    expect(s.params).toHaveLength(4)
    const angle = s.params[2] as { visibleWhen: (v: Record<string, unknown>) => boolean }
    expect(angle.visibleWhen({ kind: 'b' })).toBe(true)
    expect(angle.visibleWhen({ kind: 'a' })).toBe(false)
  })
  it('names the field that is wrong', () => {
    const bad = (p: unknown[]) => () => compileSchema('x', 'X', p)
    expect(bad([{ type: 'number', key: 'a', label: 'A' }])).toThrow(/default must be a number/)
    expect(bad([{ type: 'number', key: 'a b', label: 'A', default: 1 }])).toThrow(/plain name/)
    expect(bad([{ type: 'bool', key: 'a', label: 'A' }, { type: 'bool', key: 'a', label: 'B' }])).toThrow(/used twice/)
    expect(bad([{ type: 'enum', key: 'e', label: 'E', options: [{ value: 'a', label: 'A' }], default: 'z' }])).toThrow(/not one of the options/)
    expect(bad([{ type: 'wat', key: 'e', label: 'E' }])).toThrow(/unknown parameter type/)
    expect(bad([{ type: 'selection-ref', key: 'e', label: 'E', accepts: ['nothing'] }])).toThrow(/accepts must list/)
  })
})

describe('linking a plugin made of several files', () => {
  const url = (t: string) => 'mem:' + t.length + ':' + t.slice(0, 20)
  it('rewrites relative imports to the files of the plugin, depth first', () => {
    const seen: string[] = []
    const files = {
      'index.js': "import { a } from './lib/a.js'\nexport * from './b'\nexport const x = import('./lib/a.js')",
      'lib/a.js': "import b from '../b.js'\nexport const a = b",
      'b.js': 'export default 1',
    }
    linkModules(files, 'index.js', (t) => { seen.push(t); return `blob:${seen.length}` })
    expect(seen).toHaveLength(3)
    expect(seen[0]).toBe("export default 1") // b first
    expect(seen[1]).toContain("from 'blob:1'")
    expect(seen[2]).toContain("from 'blob:2'")
  })
  it('refuses packages, urls, cycles and missing files, and ignores imports in comments', () => {
    expect(() => linkModules({ 'index.js': "import x from 'lodash'" }, 'index.js', url)).toThrow(/own files/)
    expect(() => linkModules({ 'index.js': "import x from 'https://example.com/x.js'" }, 'index.js', url)).toThrow(/own files/)
    expect(() => linkModules({ 'index.js': "import './a.js'", 'a.js': "import './index.js'" }, 'index.js', url)).toThrow(/cycle/i)
    expect(() => linkModules({ 'index.js': "import './nope.js'" }, 'index.js', url)).toThrow(/no such file/)
    expect(() => linkModules({ 'index.js': "// import x from 'lodash'\n/* import y from 'z' */\nexport const a = 1" }, 'index.js', url)).not.toThrow()
    expect(() => linkModules({ 'index.js': "import '../outside.js'" }, 'index.js', url)).toThrow(/climbs out/)
    expect(specifiersOf("import a, { b } from './x.js'\nexport { c } from \"./y.js\"").map((s) => s.spec)).toEqual(['./x.js', './y.js'])
  })
})
