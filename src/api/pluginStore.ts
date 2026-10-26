/**
 * Installed plugins: kept in IndexedDB (their source files, copied when they were added), switched on and off from the Plugins
 * panel, started when the app starts. Reading a plugin from a folder or a single file is here too.
 */
import { createStore, del, set, values, type UseStore } from 'idb-keyval'
import { create } from 'zustand'
import { toast } from '@/ui/Modal'
import { PluginHost, type LogLine, type PluginSpec, type PluginState } from './host'
import { PERMISSIONS } from './runtime/surface.js'
import type { Package } from './package'
import { createIframeTransport } from './sandbox'
import { appServices } from './services'

export * from './package'

export interface PluginRecord {
  id: string
  name: string
  version: string
  description: string
  /** the file (or folder) it came from, for the list */
  origin: string
  entry: string
  files: Record<string, string>
  /** what its manifest asked for */
  permissions: string[]
  /** what the user allowed */
  granted: string[]
  enabled: boolean
  addedAt: number
}

export interface PluginStatus { state: PluginState; error: string | null; features: number; commands: number; problems: string[]; logs: LogLine[] }

let db: UseStore | null = null
const store = () => (db ??= createStore('caddy-plugins', 'plugins'))

// ---------------------------------------------------------------- running plugins

interface PluginsState {
  records: PluginRecord[]
  status: Record<string, PluginStatus>
  loaded: boolean
  load: () => Promise<void>
  install: (pkg: Package, granted: string[]) => Promise<PluginRecord>
  remove: (id: string) => Promise<void>
  setEnabled: (id: string, on: boolean) => Promise<void>
  setGranted: (id: string, perms: string[]) => Promise<void>
  restart: (id: string) => Promise<void>
}

const hosts = new Map<string, PluginHost>()
const specOf = (r: PluginRecord): PluginSpec => ({ id: r.id, name: r.name, files: r.files, entry: r.entry, granted: r.granted })

export const usePlugins = create<PluginsState>((set_, get_) => {
  const publish = (h: PluginHost) => {
    set_((s) => ({
      status: { ...s.status, [h.spec.id]: { state: h.state, error: h.error, features: h.features.length, commands: h.commands.length, problems: [...h.problems], logs: [...h.logs] } },
    }))
  }
  // the list is updated first, so the panel answers a click at once; the copy in IndexedDB follows
  const put = async (r: PluginRecord) => {
    set_((s) => ({ records: [...s.records.filter((x) => x.id !== r.id), r].sort((a, b) => a.name.localeCompare(b.name)) }))
    await set(r.id, r, store())
  }
  const startHost = async (r: PluginRecord) => {
    hosts.get(r.id)?.stop()
    const h = new PluginHost(specOf(r), appServices(), (spec) => createIframeTransport(spec.files, spec.entry))
    hosts.set(r.id, h)
    h.onChange(() => publish(h))
    publish(h)
    await h.start()
    publish(h)
    if (h.state === 'running' && h.manifest) {
      // a single .js file names itself in its manifest export, and says what it needs
      const m = h.manifest as { name?: string; version?: string; description?: string; permissions?: string[] }
      const perms = Array.isArray(m.permissions) ? m.permissions.filter((p) => PERMISSIONS.includes(p)) : r.permissions
      const next = { ...r, name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 60) : r.name, version: typeof m.version === 'string' ? m.version.slice(0, 20) : r.version, description: typeof m.description === 'string' ? m.description.slice(0, 300) : r.description, permissions: perms }
      if (JSON.stringify(next) !== JSON.stringify(r)) { h.spec.name = next.name; await put(next) }
    }
  }
  return {
    records: [],
    status: {},
    loaded: false,

    async load() {
      if (get_().loaded) return
      set_({ loaded: true })
      let all: PluginRecord[] = []
      try { all = await values<PluginRecord>(store()) } catch (e) { console.warn('[plugins] could not read the stored plugins', e) }
      all.sort((a, b) => a.name.localeCompare(b.name))
      set_({ records: all })
      for (const r of all) if (r.enabled) await startHost(r)
    },

    async install(pkg, granted) {
      const old = get_().records.find((r) => r.id === pkg.id)
      const r: PluginRecord = {
        id: pkg.id, name: pkg.name, version: pkg.version, description: pkg.description, origin: pkg.origin, entry: pkg.entry, files: pkg.files,
        permissions: pkg.permissions, granted: granted.filter((g) => pkg.permissions.includes(g) || old?.granted.includes(g)), enabled: true, addedAt: Date.now(),
      }
      await put(r)
      await startHost(r)
      return get_().records.find((x) => x.id === r.id) ?? r
    },

    async remove(id) {
      hosts.get(id)?.stop()
      hosts.delete(id)
      await del(id, store())
      set_((s) => {
        const status = { ...s.status }
        delete status[id]
        return { records: s.records.filter((r) => r.id !== id), status }
      })
    },

    async setEnabled(id, on) {
      const r = get_().records.find((x) => x.id === id)
      if (!r) return
      const next = { ...r, enabled: on }
      await put(next)
      if (on) await startHost(next)
      else {
        const h = hosts.get(id)
        h?.stop()
        if (h) publish(h)
      }
    },

    async setGranted(id, perms) {
      const r = get_().records.find((x) => x.id === id)
      if (!r) return
      const next = { ...r, granted: perms.filter((p) => PERMISSIONS.includes(p)) }
      await put(next)
      const h = hosts.get(id)
      if (h) h.spec.granted = next.granted // takes effect at once, no restart
    },

    async restart(id) {
      const r = get_().records.find((x) => x.id === id)
      if (r) await startHost(r)
    },
  }
})

/** The running host of a plugin (for the panel's log and the e2e specs). */
export const hostOf = (id: string) => hosts.get(id)

/** Start the enabled plugins. Call once when the app has started. */
export async function initPlugins() {
  try { await usePlugins.getState().load() } catch (e) { toast(`Could not start the plugins: ${e instanceof Error ? e.message : String(e)}`, 'error') }
}

