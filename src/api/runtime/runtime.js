// The sandbox runtime: the first script a plugin's Web Worker runs. It builds the `caddy` object, talks to the host over a
// MessagePort, links and imports the plugin's files, and answers the host's calls into the plugin (feature compute, commands).
// Plain JavaScript on purpose: the host loads this file as text and starts it inside the sandbox (see sandbox.ts).
//
// In the worker, surface.js and link.js are placed in front of this file and the import lines below are dropped (sandbox.ts);
// the Node tests import them as modules.
import { METHODS, API_VERSION } from './surface.js'
import { linkModules } from './link.js'

export function boot(scope, env) {
  env = env || {}
  const makeUrl = env.makeUrl || ((text) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' })))
  const load = env.load || ((url) => import(url))
  // the page's own console methods, kept before harden() swaps them for ones that also report to the host
  const origConsole = {}
  for (const level of ['log', 'info', 'warn', 'error']) {
    if (scope.console && typeof scope.console[level] === 'function') origConsole[level] = scope.console[level].bind(scope.console)
  }

  let port = null
  let nextId = 1
  const pending = new Map()
  const features = new Map()
  const commands = new Map()
  const listeners = new Map()
  let nextSub = 1
  let manifest = null
  let mod = null

  const send = (msg, transfer) => port.postMessage(msg, transfer || [])
  const plain = (e) => ({ message: e && e.message ? String(e.message) : String(e), stack: e && e.stack ? String(e.stack) : '' })

  function call(method, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      send({ t: 'call', id, method, args })
    })
  }

  const show = (v) => {
    if (typeof v === 'string') return v
    try { return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v) } catch { return String(v) }
  }
  const logTo = (level) => (...args) => {
    try { send({ t: 'log', level, text: args.map(show).join(' ').slice(0, 4000) }) } catch { /* the port is gone */ }
    if (origConsole[level]) origConsole[level](...args)
  }

  // the dotted names of the surface, turned into functions that call the host
  function at(root, path) {
    const parts = path.split('.')
    let o = root
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] || (o[parts[i]] = {})
    return [o, parts[parts.length - 1]]
  }

  function subscribe(kind, cb) {
    if (typeof cb !== 'function') throw new TypeError('onChange needs a function')
    const sid = nextSub++
    listeners.set(sid, cb)
    call(kind + '.subscribe', { sid }).catch(() => {})
    return { dispose() { if (listeners.delete(sid)) call(kind + '.unsubscribe', { sid }).catch(() => {}) } }
  }

  function buildApi() {
    const api = { version: API_VERSION }
    for (const m of METHODS) {
      if (/\.(subscribe|unsubscribe)$/.test(m)) continue
      const [o, k] = at(api, m)
      o[k] = (arg, ...rest) => {
        if (m === 'io.download') return call(m, { name: arg, data: rest[0], mime: rest[1] })
        if (m === 'document.addFeature') return call(m, { type: arg, params: rest[0], name: rest[1] })
        if (m === 'document.updateFeature') return call(m, { id: arg, params: rest[0] })
        if (m === 'document.removeFeature' || m === 'commands.run') return call(m, { id: arg })
        if (m === 'ui.toast') { call(m, { message: arg, kind: rest[0] }).catch(() => {}); return undefined }
        return call(m, arg)
      }
    }
    api.log = { log: logTo('log'), info: logTo('info'), warn: logTo('warn'), error: logTo('error') }
    api.document.onChange = (cb) => subscribe('document', cb)
    api.selection.onChange = (cb) => subscribe('selection', cb)
    api.features = {
      register(def) {
        if (!def || typeof def.type !== 'string' || typeof def.compute !== 'function') throw new TypeError('features.register needs { type, label, params, compute }')
        if (features.has(def.type)) throw new Error('The feature "' + def.type + '" is already registered')
        features.set(def.type, def.compute)
        const copy = Object.assign({}, def)
        delete copy.compute
        send({ t: 'register', kind: 'feature', def: JSON.parse(JSON.stringify(copy)) })
      },
    }
    const runCommand = api.commands.run
    api.commands = {
      register(def) {
        if (!def || typeof def.id !== 'string' || typeof def.run !== 'function') throw new TypeError('commands.register needs { id, label, run }')
        if (commands.has(def.id)) throw new Error('The command "' + def.id + '" is already registered')
        commands.set(def.id, def.run)
        const copy = Object.assign({}, def)
        delete copy.run
        send({ t: 'register', kind: 'command', def: JSON.parse(JSON.stringify(copy)) })
      },
      run: runCommand,
    }
    const addToRibbon = (entry) => send({ t: 'register', kind: 'ribbon', def: JSON.parse(JSON.stringify(entry)) })
    api.ribbon = { add: addToRibbon }
    api.kernel.mesh = api.kernel.mesh || {}
    return api
  }

  // lock the sandbox down further than the CSP already does: nothing here can reach a network or storage
  function harden() {
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'SharedWorker', 'Worker', 'WebTransport', 'RTCPeerConnection']) {
      try { Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false }) } catch { /* not there to remove */ }
    }
    try { if (scope.navigator) Object.defineProperty(scope.navigator, 'sendBeacon', { value: undefined }) } catch { /* ignore */ }
    for (const level of ['log', 'info', 'warn', 'error']) {
      try { scope.console[level] = logTo(level) } catch { /* ignore */ }
    }
  }

  async function run(kind, key, args) {
    if (kind === 'feature') {
      const fn = features.get(key)
      if (!fn) throw new Error('No feature "' + key + '" in this plugin')
      const ctx = { feature: args.feature, bodies: args.bodies, kernel: scope.caddy.kernel }
      return fn(ctx, args.params)
    }
    if (kind === 'command') {
      const fn = commands.get(key)
      if (!fn) throw new Error('No command "' + key + '" in this plugin')
      await fn()
      return null
    }
    if (kind === 'deactivate') {
      if (mod && typeof mod.deactivate === 'function') await mod.deactivate()
      return null
    }
    throw new Error('Unknown request ' + kind)
  }

  function onHostMessage(ev) {
    const m = ev.data
    if (!m) return
    if (m.t === 'result') {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.ok) p.resolve(m.value)
      else { const e = new Error(m.error && m.error.message ? m.error.message : 'The request failed'); e.name = (m.error && m.error.name) || 'Error'; p.reject(e) }
    } else if (m.t === 'invoke') {
      run(m.kind, m.key, m.args).then(
        (value) => send({ t: 'result', id: m.id, ok: true, value }),
        (e) => send({ t: 'result', id: m.id, ok: false, error: plain(e) }),
      )
    } else if (m.t === 'event') {
      const cb = listeners.get(m.sid)
      if (cb) { try { cb(m.data) } catch (e) { logTo('error')('A listener failed:', plain(e).message) } }
    }
  }

  async function start(init, p) {
    port = p
    port.onmessage = onHostMessage
    try {
      harden()
      const api = buildApi()
      scope.caddy = api
      const url = linkModules(init.modules, init.entry, makeUrl)
      mod = await load(url)
      manifest = mod.manifest && typeof mod.manifest === 'object' ? JSON.parse(JSON.stringify(mod.manifest)) : null
      const activate = typeof mod.activate === 'function' ? mod.activate : typeof mod.default === 'function' ? mod.default : null
      if (activate) await activate(api)
      send({ t: 'ready', manifest })
    } catch (e) {
      send({ t: 'failed', error: plain(e) })
    }
  }

  scope.onmessage = (ev) => {
    if (ev.data && ev.data.t === 'init' && ev.ports && ev.ports[0]) void start(ev.data, ev.ports[0])
  }
}
