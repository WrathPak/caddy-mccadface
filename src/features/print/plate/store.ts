/** State of the Print workspace plate: the tool, the placement being dragged, the bed, and writing placements into the document. */
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { useDoc } from '@/doc/store'
import { useUi } from '@/store/ui'
import { machineBed } from '../engine/profiles'
import { plateTextOf, settingsOf, updatePrintSettings, type PrintSettings } from '../settings'
import { useSlice } from '../engine/sliceStore'
import { bedFromPoly, parsePlate, settleEntries, overlapsOf, rectBed, resolvePlate, serializePlate, type BedShape, type PlaceEntry, type PlateResult, type PlateStore } from './model'
import type { Body } from '@/kernel/types'

export type PlateTool = 'move' | 'rotate' | 'face'

interface PlateState {
  tool: PlateTool
  /** the placements being dragged (not yet in the document) */
  live: PlateStore
  /** what is running right now (auto orient), for the toolbar */
  busy: string | null
}

export const usePlate = create<PlateState>(() => ({ tool: 'move', live: {}, busy: null }))

/** Print mode: the Prepare / Preview stage. */
export const useStage = (): 'prepare' | 'preview' => {
  const preview = useSlice((s) => s.preview)
  return preview ? 'preview' : 'prepare'
}

// ---- the bed

const loaded = new Map<string, BedShape>()
const pending = new Map<string, Promise<BedShape>>()

const fallbackBed = (p: PrintSettings['profile']) => rectBed(p.bed[0], p.bed[1], p.height)

/** The real bed of a printer preset, from the machine's printable area and height. */
export function bedFor(profile: PrintSettings['profile']): Promise<BedShape> {
  const key = profile.vendor + '|' + profile.machine
  const hit = loaded.get(key)
  if (hit) return Promise.resolve(hit)
  let p = pending.get(key)
  if (!p) {
    p = machineBed(profile.vendor, profile.machine).then((g) => {
      const shape = g.poly.length >= 3 ? bedFromPoly(g.poly, g.height) : fallbackBed(profile)
      loaded.set(key, shape)
      return shape
    }, () => fallbackBed(profile)).finally(() => pending.delete(key))
    pending.set(key, p)
  }
  return p
}

export function useBed(): BedShape {
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const profile = useMemo(() => settingsOf(features, rollback).profile, [features, rollback])
  const key = profile.vendor + '|' + profile.machine
  const [, bump] = useState(0)
  useEffect(() => {
    if (loaded.has(key)) return
    let live = true
    void bedFor(profile).then(() => { if (live) bump((n) => n + 1) })
    return () => { live = false }
  }, [key, profile])
  const shape = loaded.get(key)
  return useMemo(() => shape ?? fallbackBed(profile), [shape, profile])
}

// ---- which bodies are on the plate

/** The bodies that sit on the plate: the visible solids. An assembly keeps its own layout (it is arranged when sliced). */
export function plateBodies(geometry: Body[], hidden: Record<string, true>): Body[] {
  return geometry.filter((b) => !hidden[b.id] && !b.surface)
}

export const isAssembly = () => useDoc.getState().assembly.occurrences.length > 0

export interface Plate extends PlateResult { bed: BedShape; bodies: Body[]; stored: PlateStore; overlaps: [string, string][] }
const rkeyOf = (r: number[]) => r.map((v) => v.toFixed(3)).join(',')

const EMPTY: Plate = { list: [], entries: {}, bed: rectBed(256, 256, 256), bodies: [], stored: {}, overlaps: [] }

/** The plate every part of the Print workspace reads: published by usePlateCompute (once, in PrintHud). */
const useModelStore = create<{ model: Plate }>(() => ({ model: EMPTY }))
export const usePlateModel = (): Plate => useModelStore((s) => s.model)
export const getPlateModel = (): Plate => useModelStore.getState().model

/** Work out the plate (stored placements, arranged new bodies, the live drag) and publish it. Mounted once. */
export function usePlateCompute(enabled: boolean) {
  const geometry = useDoc((s) => s.geometry)
  const features = useDoc((s) => s.features)
  const rollback = useDoc((s) => s.rollback)
  const hidden = useUi((s) => s.hiddenIds)
  const live = usePlate((s) => s.live)
  const bed = useBed()
  const text = plateTextOf(features, rollback)
  const model = useMemo(() => {
    if (!enabled) return { ...EMPTY, bed }
    const bodies = plateBodies(geometry, hidden)
    const stored = parsePlate(text)
    const res = resolvePlate(bodies, { ...stored, ...live }, bed)
    return { ...res, bed, bodies, stored, overlaps: overlapsOf(res.list) }
  }, [enabled, geometry, hidden, text, live, bed])
  useLayoutEffect(() => { useModelStore.setState({ model }) }, [model])
}

/** The plate as it stands now, outside React (undo-aware: it reads the document). */
export function currentPlate(bed: BedShape): Plate {
  const d = useDoc.getState()
  const bodies = plateBodies(d.geometry, useUi.getState().hiddenIds)
  const stored = parsePlate(plateTextOf(d.features, d.rollback))
  const res = resolvePlate(bodies, stored, bed)
  return { ...res, bed, bodies, stored, overlaps: overlapsOf(res.list) }
}

/** Write placements into the document (one undo step). Entries of bodies that no longer exist are dropped. */
export function commitPlacements(change: PlateStore, label: string, resolved: PlateStore) {
  const d = useDoc.getState()
  const alive = new Set(d.geometry.map((b) => b.id))
  let next: PlateStore = {}
  for (const [id, e] of Object.entries({ ...resolved, ...change })) if (alive.has(id)) next[id] = e as PlaceEntry
  // a part that was turned has a new footprint: if it now sits on a neighbour, it moves to the nearest free spot
  const turned = Object.keys(change).filter((id) => resolved[id] && next[id] && rkeyOf(resolved[id].r) !== rkeyOf(next[id].r))
  const model = useModelStore.getState().model
  if (turned.length) next = settleEntries(model.bodies, next, turned, model.bed)
  usePlate.setState({ live: {} })
  updatePrintSettings(() => ({ plate: serializePlate(next) }), label)
}

/** Parts that do not fit, with the reason. */
export function plateProblems(list: { id: string; status: string; size: number[] }[], names: Record<string, string>, bed: BedShape): string[] {
  const out: string[] = []
  for (const p of list) {
    const n = names[p.id] ?? 'A part'
    if (p.status === 'tall') out.push(`${n} is ${p.size[2].toFixed(0)} mm tall, more than this printer's ${bed.height.toFixed(0)} mm. Lay it on its side or scale it down.`)
    else if (p.status === 'outside') out.push(`${n} sticks out past the edge of the plate. Move it inside, or press Arrange.`)
  }
  return out
}

export const bodyNames = (): Record<string, string> => {
  const d = useDoc.getState()
  return Object.fromEntries(d.geometry.map((b) => [b.id, d.bodyNames[b.id] ?? b.name]))
}

