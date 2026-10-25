import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { api } from '@/kernel/api'
import { computeApi } from '@/kernel/compute'
import type { Body } from '@/kernel/types'
import type { FeatureCtx, FeatureDef } from '@/doc/types'
import { PluginHost, type HostServices, type PluginSpec } from './host'
import { createLocalTransport } from './localTransport'
import { API_OUTLINE } from './completions'
import { METHODS } from './runtime/surface.js'
import { parseManifest } from './package'

const root = path.resolve(import.meta.dirname, '../..')
const dir = (name: string) => path.join(root, 'examples/plugins', name)

function load(name: string): { spec: PluginSpec; manifest: ReturnType<typeof parseManifest> } {
  const files: Record<string, string> = {}
  for (const f of fs.readdirSync(dir(name))) if (/\.m?js$/.test(f)) files[f] = fs.readFileSync(path.join(dir(name), f), 'utf8')
  const manifest = parseManifest(fs.readFileSync(path.join(dir(name), 'plugin.json'), 'utf8'))
  return { spec: { id: manifest.id!, name: manifest.name!, files, entry: manifest.main!, granted: manifest.permissions }, manifest }
}

const volume = (b: Body) => {
  const p = b.mesh.positions, ix = b.mesh.indices
  let v = 0
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, c = ix[t + 1] * 3, d = ix[t + 2] * 3
    v += (p[a] * (p[c + 1] * p[d + 2] - p[c + 2] * p[d + 1]) - p[a + 1] * (p[c] * p[d + 2] - p[c + 2] * p[d]) + p[a + 2] * (p[c] * p[d + 1] - p[c + 1] * p[d])) / 6
  }
  return Math.abs(v)
}

function app() {
  const features = new Map<string, FeatureDef>()
  const toasts: { message: string; kind: string }[] = []
  const downloads: { name: string; bytes: Uint8Array; mime: string }[] = []
  const commands = new Map<string, () => void>()
  const bodies: { body: Body; id: string; name: string }[] = []
  const svc: HostServices = {
    kernel: api as unknown as HostServices['kernel'],
    meshBooleans: (jobs) => Promise.all(jobs.map((j) => computeApi.meshBoolean(j))),
    document: {
      info: () => ({ name: 'My part', featureCount: 0, rollback: 0, dirty: false }),
      features: () => [], bodies: () => bodies, userParams: () => [], addFeature: () => 'f1', updateFeature: () => {}, removeFeature: () => {}, subscribe: () => () => {},
    },
    selection: { get: () => [], set: () => {}, subscribe: () => () => {} },
    bodyIds: (r) => r,
    registerFeature: (d) => void features.set(d.type, d),
    unregisterFeature: () => {},
    registerCommand: (c) => void commands.set(c.id, c.run),
    unregisterCommand: () => {},
    commandExists: () => true,
    runCommand: () => {},
    startFeature: () => {},
    addRibbon: () => {},
    clearRibbon: () => {},
    toast: (message, kind) => void toasts.push({ message, kind }),
    download: (name, bytes, mime) => void downloads.push({ name, bytes, mime }),
    regenerate: () => {},
  }
  return { svc, features, toasts, downloads, commands, bodies }
}

const ctx = (id = 'f1', name = 'Gear1'): FeatureCtx => ({
  feature: { id, type: 't', name }, bodies: [], body: () => undefined, kernel: api as never, blob: () => undefined,
  newBodyId: (n) => (n ? `${id}.${n}` : id), dataOf: () => undefined, featureById: () => undefined, stateAround: () => undefined,
})

beforeAll(async () => { await api.init() }, 60_000)

describe('the example plugins', () => {
  it('have a valid plugin.json and type check against caddy-api.d.ts (a real tsc run over examples/plugins)', () => {
    for (const n of ['gear-generator', 'export-all-stl']) expect(() => load(n)).not.toThrow()
    const tsc = path.join(root, 'node_modules/typescript/lib/tsc.js')
    try {
      execFileSync(process.execPath, [tsc, '-p', path.join(root, 'examples/plugins/tsconfig.json')], { cwd: root, stdio: 'pipe', timeout: 120_000 })
    } catch (e) {
      throw new Error('examples do not type check:\n' + String((e as { stdout?: Buffer }).stdout ?? e))
    }
  }, 150_000)

  describe('gear generator', () => {
    const start = async () => {
      const a = app()
      const { spec } = load('gear-generator')
      const host = new PluginHost(spec, a.svc, (s) => Promise.resolve(createLocalTransport(s.files, s.entry)))
      await host.start()
      expect(host.error).toBeNull()
      return { ...a, host, def: a.features.get('gear-generator.gear')! }
    }

    it('registers a Gear feature whose dialog has the gear parameters', async () => {
      const { def, host } = await start()
      expect(def.label).toBe('Gear')
      expect(def.schema.params.map((p) => ('key' in p ? p.key : p.label))).toEqual(['teeth', 'module', 'pressureAngle', 'thickness', 'bore', 'position'])
      host.stop()
    })

    it('builds a gear of the right size, thickness and bore', async () => {
      const { def, host } = await start()
      const p = { teeth: 20, module: 2, pressureAngle: 20, thickness: 8, bore: 6, position: [0, 0, 0] as [number, number, number] }
      const r = await def.compute(ctx(), p)
      expect(r.bodies).toHaveLength(1)
      const b = r.bodies![0]
      expect(b.kind).toBe('brep')
      let rMax = 0, zMin = Infinity, zMax = -Infinity
      for (let i = 0; i < b.mesh.positions.length; i += 3) {
        rMax = Math.max(rMax, Math.hypot(b.mesh.positions[i], b.mesh.positions[i + 1]))
        zMin = Math.min(zMin, b.mesh.positions[i + 2]); zMax = Math.max(zMax, b.mesh.positions[i + 2])
      }
      expect(rMax).toBeCloseTo(22, 1) // tip radius = pitch radius (20) + module (2)
      expect(zMin).toBeCloseTo(0, 6)
      expect(zMax).toBeCloseTo(8, 6)
      const solid = volume(b)
      const rootCircle = Math.PI * 17.5 ** 2 * 8, tipCircle = Math.PI * 22 ** 2 * 8, bore = Math.PI * 9 * 8
      expect(solid).toBeGreaterThan(rootCircle - bore)
      expect(solid).toBeLessThan(tipCircle - bore)
      // no bore: the gear is heavier by exactly the bore
      const solidGear = volume((await def.compute(ctx(), { ...p, bore: 0 })).bodies![0])
      expect(solidGear - solid).toBeCloseTo(Math.PI * 9 * 8, -1)
      host.stop()
    })

    it('more teeth make a bigger gear, a position moves it, and a bad bore says what is wrong', async () => {
      const { def, host } = await start()
      const base = { teeth: 30, module: 1.5, pressureAngle: 20, thickness: 5, bore: 5, position: [10, 20, 30] as [number, number, number] }
      const r = await def.compute(ctx(), base)
      const xs = [...r.bodies![0].mesh.positions].filter((_, i) => i % 3 === 0)
      expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(10, 1)
      expect(Math.max(...xs) - 10).toBeCloseTo((1.5 * 30) / 2 + 1.5, 1)
      await expect(def.compute(ctx(), { ...base, bore: 60 })).rejects.toThrow(/bore is too big/)
      expect((await def.compute(ctx(), { ...base, teeth: 10, bore: 2 })).warning).toMatch(/undercut/)
      host.stop()
    })
  })

  describe('export all bodies as STLs', () => {
    const start = async (granted?: string[]) => {
      const a = app()
      const { spec } = load('export-all-stl')
      if (granted) spec.granted = granted
      const host = new PluginHost(spec, a.svc, (s) => Promise.resolve(createLocalTransport(s.files, s.entry)))
      await host.start()
      expect(host.error).toBeNull()
      return { ...a, host }
    }
    const runIt = async (a: Awaited<ReturnType<typeof start>>) => {
      a.commands.get('export-all-stl.export-all')!()
      await new Promise((r) => setTimeout(r, 400))
    }
    const body = async (id: string, name: string, size: [number, number, number]) => ({ body: (await api.makeBox({ id, name, size, position: [0, 0, 0] })) as Body, id, name })

    it('saves several bodies as one zip of binary STLs', async () => {
      const a = await start()
      a.bodies.push(await body('f1', 'Base', [10, 10, 5]), await body('f2', 'Lid', [4, 4, 2]), await body('f3', 'Lid', [3, 3, 3]))
      await runIt(a)
      expect(a.downloads).toHaveLength(1)
      expect(a.downloads[0].name).toBe('My_part-stls.zip')
      const files = unzipSync(a.downloads[0].bytes)
      expect(Object.keys(files).sort()).toEqual(['Base.stl', 'Lid.stl', 'Lid_2.stl'])
      const dv = new DataView(files['Base.stl'].buffer, files['Base.stl'].byteOffset)
      expect(dv.getUint32(80, true)).toBe(12) // a box is 12 triangles
      expect(files['Base.stl'].length).toBe(84 + 12 * 50)
      expect(a.toasts.at(-1)).toEqual({ message: 'Exported 3 bodies', kind: 'info' })
    })

    it('a single body is just an STL file', async () => {
      const a = await start()
      a.bodies.push(await body('f1', 'Only one', [2, 2, 2]))
      await runIt(a)
      expect(a.downloads.map((d) => [d.name, d.mime])).toEqual([['Only_one.stl', 'model/stl']])
    })

    it('says so when there is nothing to export', async () => {
      const a = await start()
      await runIt(a)
      expect(a.downloads).toEqual([])
      expect(a.toasts.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('no bodies') })
    })

    it('cannot download unless the user allowed it', async () => {
      const a = await start([])
      a.bodies.push(await body('f1', 'Base', [2, 2, 2]))
      await runIt(a)
      expect(a.downloads).toEqual([])
      expect(a.toasts.at(-1)!.message).toContain('"download" permission')
    })
  })
})

describe('the API reference', () => {
  const dts = fs.readFileSync(path.join(root, 'src/api/caddy-api.d.ts'), 'utf8')
  it('mentions every call of the runtime surface', () => {
    for (const m of METHODS) {
      if (/\.(subscribe|unsubscribe)$/.test(m)) continue
      expect(dts, m).toMatch(new RegExp(`\\b${m.split('.').pop()}\\(`))
    }
  })
  it('has every completion entry', () => {
    for (const [p] of API_OUTLINE) {
      const last = p.split('.').pop()!
      expect(dts, p).toMatch(new RegExp(`\\b${last}\\b`))
    }
  })
  it('the completion list covers every call of the surface', () => {
    const listed = new Set(API_OUTLINE.map(([p]) => p.replace(/^caddy\./, '')))
    for (const m of METHODS) {
      if (/\.(subscribe|unsubscribe)$/.test(m)) continue
      expect(listed.has(m), m).toBe(true)
    }
  })
})
