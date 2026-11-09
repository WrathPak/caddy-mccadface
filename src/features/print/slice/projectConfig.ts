/** `Metadata/project_settings.config`: the presets exactly as sliced, flattened into one project config the way Orca writes it. */
import type { Config, ConfigValue } from '@muon3d/slicer-engine-protocol'
import type { Resolved } from '../engine/profiles'
import type { SliceProfile } from './profile'

const META = new Set(['type', 'instantiation', 'setting_id', 'filament_id', 'inherits', 'name', 'version', 'from', 'renamed_from', 'description', 'url', 'is_custom_defined'])
const list = (v: ConfigValue | undefined): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v])

/** Keys changed from the system preset, as Orca's `different_settings_to_system` text. */
const changed = (...patches: Record<string, string>[]) => patches.flatMap((p) => Object.keys(p)).sort().join(';')

export function flatProjectConfig(r: Resolved, p: SliceProfile): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const take = (c: Config) => { for (const [k, v] of Object.entries(c)) if (!META.has(k)) out[k] = v }
  take(r.machine)
  take(r.process)
  // filament options carry one entry per filament slot
  const keys = new Set<string>()
  for (const f of r.filaments) for (const k of Object.keys(f)) if (!META.has(k)) keys.add(k)
  for (const k of keys) out[k] = r.filaments.flatMap((f) => list(f[k]))
  const n = r.filaments.length
  out.from = 'project'
  out.name = 'project_settings'
  out.version = '2.3.2'
  out.print_settings_id = r.processName
  out.printer_settings_id = p.machine
  out.filament_settings_id = r.filamentNames
  out.different_settings_to_system = [
    changed(p.overrides.process, p.user.process?.keys ?? {}),
    ...Array.from({ length: n }, (_, i) => changed(p.overrides.filaments[i] ?? {}, p.user.filaments[i]?.keys ?? {})),
    changed(p.overrides.machine, p.user.machine?.keys ?? {}),
  ]
  out.inherits_group = ['', ...Array.from({ length: n }, () => ''), '']
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
