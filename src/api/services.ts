/** Binds the plugin host to the running app: its stores, registries, kernel and compute pool. */
import * as Comlink from 'comlink'
import { allCommands, registerCommand, getCommand, runCommand, unregisterCommand } from '@/app/commands'
import { useRibbonExtras } from '@/app/ribbonExtras'
import { createFeature } from '@/doc/editor'
import { regenerate } from '@/doc/engine'
import { bodyIdsOf } from '@/doc/refs'
import { getFeature, registerFeature, unregisterFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import { downloadFile } from '@/io/files'
import { getKernel } from '@/kernel/client'
import { getComputePool } from '@/kernel/pool'
import { useUi, type SelectionRef } from '@/store/ui'
import { toast } from '@/ui/Modal'
import type { HostServices, KernelLike } from './host'

export function appServices(): HostServices {
  return {
    kernel: new Proxy({} as KernelLike, {
      // every call looks the kernel up again, so it is always the live worker
      get: (_t, prop: string) => (...args: unknown[]) => (getKernel() as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args),
    }),
    meshBooleans: (jobs) =>
      getComputePool().map(jobs, (w, j) =>
        w.meshBoolean(Comlink.transfer(j, [j.base.positions.buffer as ArrayBuffer, j.base.indices.buffer as ArrayBuffer, ...j.tools.flatMap((t) => [t.positions.buffer as ArrayBuffer, t.indices.buffer as ArrayBuffer])])),
      ),
    document: {
      info: () => {
        const s = useDoc.getState()
        return { name: s.name, featureCount: s.features.length, rollback: s.rollback, dirty: s.dirty }
      },
      features: () => useDoc.getState().features.map((f) => ({ id: f.id, type: f.type, name: f.name, state: f.state, suppressed: f.suppressed, params: JSON.parse(JSON.stringify(f.params)) })),
      bodies: () => {
        const s = useDoc.getState()
        return s.geometry.map((b) => ({ body: b, id: b.id, name: s.bodyNames[b.id] ?? b.name }))
      },
      userParams: () => useDoc.getState().userParams.map((p) => ({ name: p.name, expr: p.expr })),
      addFeature: (type, params, name) => {
        if (!getFeature(type)) throw new Error(`There is no feature type "${type}"`)
        return useDoc.getState().addFeature(type, params, name)
      },
      updateFeature: (id, params) => {
        if (!useDoc.getState().features.some((f) => f.id === id)) throw new Error(`There is no feature ${id}`)
        useDoc.getState().updateFeature(id, params)
      },
      removeFeature: (id) => {
        if (!useDoc.getState().features.some((f) => f.id === id)) throw new Error(`There is no feature ${id}`)
        useDoc.getState().removeFeature(id)
      },
      subscribe: (cb) => useDoc.subscribe((s, p) => { if (s.features !== p.features || s.geometry !== p.geometry) cb() }),
    },
    selection: {
      get: () => useUi.getState().selection.map((r) => ({ kind: r.kind, id: r.id, ...(r.index !== undefined ? { index: r.index } : {}) })),
      set: (refs) => useUi.getState().setSelection(refs as SelectionRef[]),
      subscribe: (cb) => useUi.subscribe((s, p) => { if (s.selection !== p.selection) cb(s.selection.map((r) => ({ kind: r.kind, id: r.id, ...(r.index !== undefined ? { index: r.index } : {}) }))) }),
    },
    bodyIds: (refs) => bodyIdsOf(refs),
    registerFeature,
    unregisterFeature,
    registerCommand: (c) => {
      // a shortcut that another command already uses stays with that command
      const clash = !!c.shortcut && allCommands().some((x) => x.shortcut === c.shortcut && x.id !== c.id)
      registerCommand({ ...c, shortcut: clash ? undefined : c.shortcut })
    },
    unregisterCommand,
    commandExists: (id) => !!getCommand(id),
    runCommand,
    startFeature: (type) => createFeature(type, {}, type),
    addRibbon: (owner, e) => useRibbonExtras.getState().add({ owner, ...e }),
    clearRibbon: (owner) => useRibbonExtras.getState().clearOwner(owner),
    toast,
    download: (name, data, mime) => downloadFile(name, data, mime),
    regenerate: () => void regenerate(),
  }
}
