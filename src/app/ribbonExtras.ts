/** Ribbon buttons that plugins add on top of the built-in layout (ribbon.ts). */
import { create } from 'zustand'
import type { RibbonGroup, RibbonTab } from './ribbon'

export interface RibbonExtra { owner: string; tab: string; group: string; cmd: string }

export const useRibbonExtras = create<{
  items: RibbonExtra[]
  add: (e: RibbonExtra) => void
  clearOwner: (owner: string) => void
}>((set) => ({
  items: [],
  add: (e) => set((s) => (s.items.some((x) => x.owner === e.owner && x.tab === e.tab && x.group === e.group && x.cmd === e.cmd) ? s : { items: [...s.items, e] })),
  clearOwner: (owner) => set((s) => (s.items.some((x) => x.owner === owner) ? { items: s.items.filter((x) => x.owner !== owner) } : s)),
}))

/** The tab's groups with the plugins' buttons put in: into the group of that name, or into a new group at the end. */
export function withExtras(tab: RibbonTab, extras: RibbonExtra[]): RibbonGroup[] {
  const mine = extras.filter((e) => e.tab === tab.id)
  if (!mine.length) return tab.groups
  const groups = tab.groups.map((g) => ({ ...g, items: [...g.items] }))
  for (const e of mine) {
    const g = groups.find((x) => x.label === e.group)
    if (g) g.items.push({ cmd: e.cmd })
    else groups.push({ label: e.group, items: [{ cmd: e.cmd }] })
  }
  return groups
}
