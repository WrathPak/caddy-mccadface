/**
 * The host side of the plugin API. One PluginHost per running plugin: it owns the sandbox's transport, answers the plugin's
 * calls (each checked against the permissions the user granted), registers what the plugin contributes (features, commands,
 * ribbon buttons) with the app, and takes it all back when the plugin stops.
 *
 * Everything the app provides goes through `HostServices`, so the whole protocol is testable with the real kernel and the
 * in-process sandbox, and the app plugs in its stores in services.ts.
 */
import type { Icon } from '@phosphor-icons/react'
import type { FeatureCtx, FeatureDef, FeatureResult } from '@/doc/types'
import { bbox, type Body, type TopoMesh } from '@/kernel/types'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { METHODS, NEEDS, API_VERSION } from './runtime/surface.js'
import { bodyOnlyKeys, compileSchema, iconOf } from './schema'
import type { Transport } from './sandbox'

// ---------------------------------------------------------------- what the app provides

export interface KernelLike {
  makeBox(a: { id: string; name: string; size: [number, number, number]; position: [number, number, number] }): Promise<Body>
  createMesh(a: { id: string; name: string; positions: Float32Array; indices?: Uint32Array }): Promise<Body>
  boolean(a: { id: string; name: string; op: 'union' | 'subtract' | 'intersect'; base: string; tools: string[] }): Promise<Body>
  meshBoolean(a: { id: string; name: string; op: 'union' | 'subtract' | 'intersect'; base: string; tools: string[] }): Promise<Body>
  transform(a: { id: string; name: string; key: string; spec: { pivot: [number, number, number]; translate: [number, number, number]; rotate: [number, number, number]; scale: number } }): Promise<Body>
  toMeshBody(a: { id: string; name: string; key: string }): Promise<Body>
  exportMeshes(keys: string[]): Promise<TopoMesh[]>
  call(name: string, args: unknown): Promise<unknown>
}

export interface SelRef { kind: string; id: string; index?: number }
export interface FeatureRow { id: string; type: string; name: string; state: string; suppressed: boolean; params: Record<string, unknown> }

export interface CommandSpec { id: string; label: string; tip?: string; icon: Icon; shortcut?: string; category: string; run: () => void }

export interface HostServices {
  kernel: KernelLike
  /** independent mesh booleans on the compute pool */
  meshBooleans(jobs: { op: 'union' | 'subtract' | 'intersect'; base: TopoMesh; tools: TopoMesh[] }[]): Promise<TopoMesh[]>
  document: {
    info(): { name: string; featureCount: number; rollback: number; dirty: boolean }
    features(): FeatureRow[]
    bodies(): { body: Body; id: string; name: string }[]
    userParams(): { name: string; expr: string }[]
    addFeature(type: string, params: ParamValues, name?: string): string
    updateFeature(id: string, params: ParamValues): void
    removeFeature(id: string): void
    subscribe(cb: () => void): () => void
  }
  selection: { get(): SelRef[]; set(refs: SelRef[]): void; subscribe(cb: (refs: SelRef[]) => void): () => void }
  /** body ids behind encoded selection references */
  bodyIds(refs: string[]): string[]
  registerFeature(def: FeatureDef): void
  unregisterFeature(type: string): void
  registerCommand(c: CommandSpec): void
  unregisterCommand(id: string): void
  commandExists(id: string): boolean
  runCommand(id: string): void
  /** open the dialog that creates a feature of this type */
  startFeature(type: string): void
  addRibbon(owner: string, e: { tab: string; group: string; cmd: string }): void
  clearRibbon(owner: string): void
  toast(message: string, kind: 'info' | 'error'): void
  download(name: string, data: Uint8Array, mime: string): void
  regenerate(): void
}

// ---------------------------------------------------------------- the host

export interface PluginSpec {
  /** also the prefix of everything the plugin registers */
  id: string
  name: string
  files: Record<string, string>
  entry: string
  /** permissions the user allowed */
  granted: string[]
}

export type PluginState = 'stopped' | 'starting' | 'running' | 'failed'
export interface LogLine { level: 'log' | 'info' | 'warn' | 'error'; text: string; at: number }

export class PermissionError extends Error {
  constructor(public permission: string, plugin: string) {
    super(`"${plugin}" needs the "${permission}" permission. List it under "permissions" in the plugin's manifest and allow it in the Plugins panel.`)
    this.name = 'PermissionError'
  }
}

const REQUEST_TIMEOUT_MS = 60_000
const START_TIMEOUT_MS = 20_000
const MAX_LOG = 300
const MAX_HANDLES = 4000
const MAX_DOWNLOAD = 256 * 1024 * 1024
const MAX_NUMBERS = 30_000_000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${what} must be a number`)
  return v
}
function vec3(v: unknown, what: string, d?: [number, number, number]): [number, number, number] {
  if (v === undefined && d) return d
  if (!Array.isArray(v) || v.length !== 3) throw new TypeError(`${what} must be three numbers [x, y, z]`)
  return [num(v[0], what), num(v[1], what), num(v[2], what)]
}
function oneOf<T extends string>(v: unknown, what: string, ok: readonly T[]): T {
  if (typeof v !== 'string' || !ok.includes(v as T)) throw new TypeError(`${what} must be one of ${ok.join(', ')}`)
  return v as T
}
const text = (v: unknown, what: string, max = 200): string => {
  if (typeof v !== 'string' || !v.length) throw new TypeError(`${what} must be a text`)
  return v.slice(0, max)
}

/** Typed arrays at the top level of a reply, so their buffers move instead of being copied. */
function transferables(v: unknown): Transferable[] {
  const out: Transferable[] = []
  const scan = (x: unknown, depth: number) => {
    if (ArrayBuffer.isView(x)) out.push(x.buffer as ArrayBuffer)
    else if (depth < 2 && x && typeof x === 'object') for (const y of Object.values(x)) scan(y, depth + 1)
  }
  scan(v, 0)
  return out
}

export class PluginHost {
  state: PluginState = 'stopped'
  error: string | null = null
  manifest: Obj | null = null
  logs: LogLine[] = []
  features: string[] = []
  commands: string[] = []
  /** problems with a registration (the plugin keeps running) */
  problems: string[] = []

  private transport: Transport | null = null
  private listeners = new Set<() => void>()
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private handles = new Map<string, { body: Body; scope: number }>()
  private bodyCounter = 0
  private scopeCounter = 0
  private activeScope = 0
  private subs = new Map<number, () => void>()
  private ready: { resolve: () => void; reject: (e: Error) => void } | null = null

  constructor(
    public spec: PluginSpec,
    private svc: HostServices,
    private open: (spec: PluginSpec) => Promise<Transport>,
  ) {}

  /** How many change listeners the plugin has open (a script that listens keeps running). */
  get listening() { return this.subs.size }

  /** Called after any change of state, log or registrations. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private changed() { for (const l of this.listeners) l() }

  /** Start the sandbox and the plugin; resolves when its activate() has finished. */
  async start(): Promise<void> {
    if (this.state === 'starting' || this.state === 'running') return
    this.state = 'starting'
    this.error = null
    this.problems = []
    this.changed()
    try {
      this.transport = await this.open(this.spec)
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e))
    }
    this.transport.onMessage((m) => this.onMessage(m))
    this.transport.onCrash((r) => this.fail(r))
    const ready = new Promise<void>((resolve, reject) => { this.ready = { resolve, reject } })
    ready.catch(() => {})
    const timer = setTimeout(() => this.fail(`"${this.spec.name}" did not finish starting within ${START_TIMEOUT_MS / 1000} s`), START_TIMEOUT_MS)
    try {
      await ready
    } catch {
      /* fail() recorded it */
    } finally {
      clearTimeout(timer)
    }
  }

  private fail(message: string) {
    this.error = message
    this.state = 'failed'
    this.teardown()
    this.ready?.reject(new Error(message))
    this.ready = null
    this.changed()
  }

  /** Stop the plugin and remove everything it added to the app. */
  stop() {
    if (this.state === 'stopped') return
    this.teardown()
    this.state = 'stopped'
    this.error = null
    this.ready?.reject(new Error('stopped'))
    this.ready = null
    this.changed()
  }

  private teardown() {
    for (const off of this.subs.values()) off()
    this.subs.clear()
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The plugin was stopped')) }
    this.pending.clear()
    this.transport?.terminate()
    this.transport = null
    this.handles.clear()
    for (const t of this.features) this.svc.unregisterFeature(t)
    for (const c of this.commands) this.svc.unregisterCommand(c)
    this.svc.clearRibbon(this.spec.id)
    const hadFeatures = this.features.length > 0
    this.features = []
    this.commands = []
    if (hadFeatures) this.svc.regenerate()
  }

  private log(level: LogLine['level'], t: string) {
    this.logs.push({ level, text: t, at: Date.now() })
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG)
    this.changed()
  }
  /** Lines of the plugin's console, for the Script panel. */
  onLog?: (line: LogLine) => void

  // ---------------------------------------------------------------- messages from the plugin

  private onMessage(m: Obj) {
    switch (m.t) {
      case 'ready':
        this.manifest = isObj(m.manifest) ? m.manifest : null
        this.state = 'running'
        this.ready?.resolve()
        this.ready = null
        this.changed()
        // features of this plugin already in the document were waiting for their type: build them now
        if (this.features.length) this.svc.regenerate()
        break
      case 'failed':
        this.fail(isObj(m.error) && typeof m.error.message === 'string' ? m.error.message : 'The plugin failed to start')
        break
      case 'log': {
        const line: LogLine = { level: (['log', 'info', 'warn', 'error'] as const).includes(m.level as 'log') ? (m.level as LogLine['level']) : 'log', text: String(m.text ?? ''), at: Date.now() }
        this.logs.push(line)
        if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG)
        this.onLog?.(line)
        this.changed()
        break
      }
      case 'register':
        try {
          this.register(String(m.kind), m.def)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          this.problems.push(msg)
          this.log('error', msg)
        }
        break
      case 'call':
        void this.answer(Number(m.id), String(m.method), m.args)
        break
      case 'result': {
        const p = this.pending.get(Number(m.id))
        if (!p) return
        this.pending.delete(Number(m.id))
        clearTimeout(p.timer)
        if (m.ok) p.resolve(m.value)
        else p.reject(Object.assign(new Error(isObj(m.error) && typeof m.error.message === 'string' ? m.error.message : 'The plugin reported an error'), { fromPlugin: true }))
        break
      }
    }
  }

  private async answer(id: number, method: string, args: unknown) {
    try {
      const value = await this.dispatch(method, args)
      this.transport?.post({ t: 'result', id, ok: true, value }, transferables(value))
    } catch (e) {
      const err = e as Error
      this.transport?.post({ t: 'result', id, ok: false, error: { message: err?.message ?? String(e), name: err?.name ?? 'Error' } })
    }
  }

  /** Ask the plugin to run something it registered (a feature's compute, a command, deactivate). */
  invoke(kind: 'feature' | 'command' | 'deactivate', key: string, args: unknown): Promise<unknown> {
    const t = this.transport
    if (!t || this.state !== 'running') return Promise.reject(new Error(`The plugin "${this.spec.name}" is not running. Switch it on in the Plugins panel.`))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const msg = `"${this.spec.name}" did not answer within ${REQUEST_TIMEOUT_MS / 1000} s and was stopped`
        reject(new Error(msg))
        this.fail(msg)
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      t.post({ t: 'invoke', id, kind, key, args })
    })
  }

  // ---------------------------------------------------------------- what the plugin adds to the app

  private ribbonFor(p: unknown, cmd: string) {
    const o = isObj(p) ? p : {}
    const tab = o.tab === undefined ? 'solid' : oneOf(o.tab, 'ribbon.tab', ['solid', 'mesh', 'hair', 'sketch'] as const)
    const group = typeof o.group === 'string' && o.group.trim() ? o.group.slice(0, 40) : this.spec.name.slice(0, 40)
    this.svc.addRibbon(this.spec.id, { tab, group, cmd })
  }

  private register(kind: string, raw: unknown) {
    if (!isObj(raw)) throw new Error('A registration must be an object')
    const own = (id: string) => `${this.spec.id}.${id}`
    if (kind === 'feature') {
      const type = text(raw.type, 'feature type', 60)
      if (!/^[A-Za-z_]\w*$/.test(type)) throw new Error(`Feature type "${type}" must be a plain name`)
      const full = own(type)
      const label = text(raw.label, `Feature ${type} label`, 60)
      const schema = compileSchema(full, label, raw.params)
      const icon = iconOf(raw.icon)
      const bodyKeys = bodyOnlyKeys(schema)
      const def: FeatureDef = {
        type: full,
        label,
        icon,
        schema,
        compute: (ctx, params) => this.runFeature(ctx, type, bodyKeys, params),
      }
      this.svc.registerFeature(def)
      this.features.push(full)
      // a command with the feature's label starts its dialog (palette, shortcuts and the ribbon use it)
      const cmdId = `${full}.create`
      this.svc.registerCommand({ id: cmdId, label, icon, category: 'Plugins', tip: typeof raw.tip === 'string' ? raw.tip.slice(0, 300) : undefined, run: () => this.svc.startFeature(full) })
      this.commands.push(cmdId)
      if (raw.ribbon !== undefined) this.ribbonFor(raw.ribbon, cmdId)
    } else if (kind === 'command') {
      const id = text(raw.id, 'command id', 60)
      const full = own(id)
      const label = text(raw.label, `Command ${id} label`, 60)
      this.svc.registerCommand({
        id: full, label, icon: iconOf(raw.icon), category: 'Plugins',
        tip: typeof raw.tip === 'string' ? raw.tip.slice(0, 300) : undefined,
        shortcut: typeof raw.shortcut === 'string' ? raw.shortcut.slice(0, 30) : undefined,
        run: () => {
          this.invoke('command', id, {}).catch((e: Error) => this.svc.toast(`${this.spec.name}: ${e.message}`, 'error'))
        },
      })
      this.commands.push(full)
      if (raw.ribbon !== undefined) this.ribbonFor(raw.ribbon, full)
    } else if (kind === 'ribbon') {
      const cmd = text(raw.command, 'ribbon command', 80)
      const target = this.commands.includes(own(cmd)) ? own(cmd) : cmd
      if (!this.svc.commandExists(target)) throw new Error(`ribbon.add: there is no command "${cmd}"`)
      this.ribbonFor(raw, target)
    } else {
      throw new Error(`Unknown registration "${kind}"`)
    }
    this.changed()
  }

  // ---------------------------------------------------------------- building a feature

  private async runFeature(ctx: FeatureCtx, type: string, bodyKeys: string[], params: ParamValues): Promise<FeatureResult> {
    const scope = ++this.scopeCounter
    const outer = this.activeScope
    this.activeScope = scope
    try {
      const values: ParamValues = { ...params }
      for (const k of bodyKeys) if (Array.isArray(values[k])) values[k] = this.svc.bodyIds(values[k] as string[])
      const infos = ctx.bodies.map((b) => this.info(b, b.id, b.name))
      const res = await this.invoke('feature', type, { feature: { id: ctx.feature.id, name: ctx.feature.name }, bodies: infos, params: values })
      const r = isObj(res) ? res : {}
      const refs = r.bodies === undefined ? [] : Array.isArray(r.bodies) ? r.bodies : [r.bodies]
      const bodies: Body[] = []
      for (const [i, ref] of refs.entries()) {
        const b = this.bodyOf(ref)
        const name = i === 0 ? ctx.feature.name : `${ctx.feature.name} ${i + 1}`
        bodies.push((await this.svc.kernel.call('pluginFinalize', { key: b.key, id: ctx.newBodyId(i || undefined), name })) as Body)
      }
      const out: FeatureResult = { bodies }
      if (r.remove !== undefined) {
        if (!Array.isArray(r.remove) || !r.remove.every((x) => typeof x === 'string')) throw new Error('compute() returned "remove" that is not a list of body ids')
        out.remove = r.remove as string[]
      }
      if (typeof r.warning === 'string' && r.warning) out.warning = r.warning.slice(0, 400)
      return out
    } finally {
      this.activeScope = outer
      for (const [h, e] of this.handles) if (e.scope === scope) this.handles.delete(h)
    }
  }

  // ---------------------------------------------------------------- bodies the plugin refers to

  private info(body: Body, id?: string, name?: string): Obj {
    const handle = `h${++this.bodyCounter}`
    this.handles.set(handle, { body, scope: this.activeScope })
    if (this.handles.size > MAX_HANDLES) this.handles.delete(this.handles.keys().next().value as string)
    const b = bbox(body.mesh.positions)
    const out: Obj = { handle, kind: body.kind, triangles: body.mesh.indices.length / 3, bounds: { min: b.min, max: b.max } }
    if (id !== undefined) { out.id = id; out.name = name }
    return out
  }

  private bodyOf(ref: unknown): Body {
    const h = typeof ref === 'string' ? ref : isObj(ref) && typeof ref.handle === 'string' ? ref.handle : null
    if (!h) throw new TypeError('A body is the object a kernel call returned, or its handle')
    const e = this.handles.get(h)
    if (!e) throw new Error(`Unknown body ${h}: it was made in another call, or the plugin was restarted`)
    return e.body
  }

  private newId(): string { return `plugin.${this.spec.id}.${++this.bodyCounter}` }

  // ---------------------------------------------------------------- the calls a plugin can make

  async dispatch(method: string, args: unknown): Promise<unknown> {
    if (!METHODS.includes(method)) throw new Error(`Unknown call ${method}`)
    const need = (NEEDS as Record<string, string>)[method]
    if (need && !this.spec.granted.includes(need)) throw new PermissionError(need, this.spec.name)
    const a = (isObj(args) ? args : {}) as Obj
    const k = this.svc.kernel
    switch (method) {
      case 'document.info': return this.svc.document.info()
      case 'document.features': return this.svc.document.features()
      case 'document.bodies': return this.svc.document.bodies().map((x) => this.info(x.body, x.id, x.name))
      case 'document.userParams': return this.svc.document.userParams()
      case 'document.addFeature': {
        if (!isObj(a.params)) throw new TypeError('params must be an object')
        return this.svc.document.addFeature(text(a.type, 'type', 80), a.params as ParamValues, typeof a.name === 'string' ? a.name.slice(0, 80) : undefined)
      }
      case 'document.updateFeature':
        if (!isObj(a.params)) throw new TypeError('params must be an object')
        this.svc.document.updateFeature(text(a.id, 'id'), a.params as ParamValues)
        return null
      case 'document.removeFeature':
        this.svc.document.removeFeature(text(a.id, 'id'))
        return null
      case 'document.subscribe': return this.subscribe(Number(a.sid), (post) => this.svc.document.subscribe(() => post(undefined)))
      case 'selection.subscribe': return this.subscribe(Number(a.sid), (post) => this.svc.selection.subscribe((refs) => post(refs)))
      case 'document.unsubscribe':
      case 'selection.unsubscribe': {
        const off = this.subs.get(Number(a.sid))
        off?.()
        this.subs.delete(Number(a.sid))
        return null
      }
      case 'selection.get': return this.svc.selection.get()
      case 'selection.set': {
        const refs = Array.isArray(args) ? args : []
        this.svc.selection.set(refs.map((r) => {
          if (!isObj(r)) throw new TypeError('A selection entry is { kind, id, index? }')
          return { kind: text(r.kind, 'kind', 20), id: text(r.id, 'id'), ...(typeof r.index === 'number' ? { index: r.index } : {}) }
        }))
        return null
      }

      case 'kernel.box': {
        const size = vec3(a.size, 'size')
        if (size.some((s) => !(s > 0))) throw new RangeError('size must be positive in every direction')
        return this.info(await k.makeBox({ id: this.newId(), name: 'Box', size, position: vec3(a.position, 'position', [0, 0, 0]) }))
      }
      case 'kernel.cylinder':
        return this.info((await k.call('pluginCylinder', { id: this.newId(), name: 'Cylinder', radius: num(a.radius, 'radius'), height: num(a.height, 'height'), position: vec3(a.position, 'position', [0, 0, 0]) })) as Body)
      case 'kernel.sphere':
        return this.info((await k.call('pluginSphere', { id: this.newId(), name: 'Sphere', radius: num(a.radius, 'radius'), center: vec3(a.center, 'center', [0, 0, 0]) })) as Body)
      case 'kernel.extrude': {
        const plane = a.plane === undefined ? 'XY' : oneOf(a.plane, 'plane', ['XY', 'XZ', 'YZ'] as const)
        const pts = (v: unknown, what: string) => {
          if (!Array.isArray(v) || v.length > 100_000) throw new TypeError(`${what} must be a list of [x, y] points`)
          return v.map((p) => { if (!Array.isArray(p) || p.length !== 2) throw new TypeError(`${what} must be a list of [x, y] points`); return [num(p[0], what), num(p[1], what)] })
        }
        const holes = a.holes === undefined ? [] : Array.isArray(a.holes) ? a.holes.map((h, i) => pts(h, `holes[${i}]`)) : (() => { throw new TypeError('holes must be a list of point lists') })()
        return this.info((await k.call('pluginExtrude', { id: this.newId(), name: 'Extrusion', outline: pts(a.outline, 'outline'), holes, height: num(a.height, 'height'), plane, origin: vec3(a.origin, 'origin', [0, 0, 0]) })) as Body)
      }
      case 'kernel.boolean':
      case 'kernel.mesh.boolean': {
        const job = this.booleanJob(a)
        const base = { id: this.newId(), name: 'Boolean', op: job.op, base: job.base.key, tools: job.tools.map((t) => t.key) }
        const solids = [job.base, ...job.tools].every((b) => b.kind === 'brep')
        return this.info(method === 'kernel.boolean' && solids ? await k.boolean(base) : await k.meshBoolean(base))
      }
      case 'kernel.mesh.booleanMany': {
        if (!Array.isArray(args) || args.length > 256) throw new TypeError('booleanMany needs a list of up to 256 jobs')
        const jobs = (args as unknown[]).map((j) => this.booleanJob(isObj(j) ? j : {}))
        const inputs = await Promise.all(jobs.map((j) => k.exportMeshes([j.base.key, ...j.tools.map((t) => t.key)])))
        const out = await this.svc.meshBooleans(jobs.map((j, i) => ({ op: j.op, base: inputs[i][0], tools: inputs[i].slice(1) })))
        const bodies = await Promise.all(out.map((m) => k.createMesh({ id: this.newId(), name: 'Boolean', positions: m.positions, indices: m.indices })))
        return bodies.map((b) => this.info(b))
      }
      case 'kernel.transform': {
        const body = this.bodyOf(a.body)
        const spec = { pivot: vec3(a.pivot, 'pivot', [0, 0, 0]), translate: vec3(a.translate, 'translate', [0, 0, 0]), rotate: vec3(a.rotate, 'rotate', [0, 0, 0]), scale: a.scale === undefined ? 1 : num(a.scale, 'scale') }
        if (!(spec.scale > 0)) throw new RangeError('scale must be greater than zero')
        return this.info(await k.transform({ id: this.newId(), name: 'Moved', key: body.key, spec }))
      }
      case 'kernel.toMesh': return this.info(await k.toMeshBody({ id: this.newId(), name: 'Mesh', key: this.bodyOf(args).key }))
      case 'kernel.triangles': {
        const [m] = await k.exportMeshes([this.bodyOf(args).key])
        return { positions: m.positions, indices: m.indices }
      }
      case 'kernel.mesh.fromTriangles': {
        const pos = a.positions as ArrayLike<number> | undefined
        if (!pos || typeof pos.length !== 'number' || pos.length % 3 || pos.length > MAX_NUMBERS) throw new TypeError('positions must be a list of x, y, z numbers')
        const positions = Float32Array.from(pos as ArrayLike<number>)
        for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new TypeError('positions must be finite numbers')
        let indices: Uint32Array | undefined
        if (a.indices !== undefined) {
          const ix = a.indices as ArrayLike<number>
          if (typeof ix.length !== 'number' || ix.length % 3 || ix.length > MAX_NUMBERS) throw new TypeError('indices must be a list with three numbers per triangle')
          indices = Uint32Array.from(ix)
          const n = positions.length / 3
          for (let i = 0; i < indices.length; i++) if (indices[i] >= n) throw new RangeError('an index points past the last vertex')
        }
        return this.info(await k.createMesh({ id: this.newId(), name: 'Mesh', positions, indices }))
      }

      case 'commands.run': {
        const id = text(a.id, 'command id', 120)
        if (!this.svc.commandExists(id)) throw new Error(`There is no command "${id}"`)
        this.svc.runCommand(id)
        return null
      }
      case 'io.download': {
        const name = text(a.name, 'file name', 120).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        const d = a.data
        const bytes = typeof d === 'string' ? new TextEncoder().encode(d) : d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null
        if (!bytes) throw new TypeError('data must be a string, a Uint8Array or an ArrayBuffer')
        if (bytes.byteLength > MAX_DOWNLOAD) throw new RangeError('The file is too big to download')
        this.svc.download(name, bytes, typeof a.mime === 'string' ? a.mime.slice(0, 100) : 'application/octet-stream')
        return null
      }
      case 'ui.toast':
        this.svc.toast(text(a.message, 'message', 300), a.kind === 'error' ? 'error' : 'info')
        return null
    }
    throw new Error(`Unhandled call ${method}`)
  }

  private booleanJob(a: Obj) {
    const op = oneOf(a.op, 'op', ['union', 'subtract', 'intersect'] as const)
    if (!Array.isArray(a.tools) || !a.tools.length) throw new TypeError('tools must be a list with at least one body')
    return { op, base: this.bodyOf(a.base), tools: a.tools.map((t) => this.bodyOf(t)) }
  }

  private subscribe(sid: number, hook: (post: (data: unknown) => void) => () => void): null {
    if (!Number.isInteger(sid)) throw new TypeError('A subscription needs an id')
    this.subs.get(sid)?.()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last: unknown
    const off = hook((data) => {
      last = data
      clearTimeout(timer)
      timer = setTimeout(() => this.transport?.post({ t: 'event', sid, data: last }), 30)
    })
    this.subs.set(sid, () => { clearTimeout(timer); off() })
    return null
  }
}

export { API_VERSION }
export type { ParamSchema }
