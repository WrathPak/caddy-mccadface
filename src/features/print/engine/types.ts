/** What the print workspace needs from a slicer engine, kept small so another engine can sit behind it. */
import type { Config, EngineWarning, GcodeStats, Toolpaths } from '@muon3d/slicer-engine-protocol'

export type { Config, EngineWarning, GcodeStats, Toolpaths }

/** Presets picked by name from the profile set (a vendor folder id like "BBL", then Orca's preset names). */
export interface PresetSelection {
  vendor: string
  machine: string
  process: string
  /** one entry per filament slot; a single entry is repeated for every slot the plate uses */
  filaments: string[]
}

/** The flattened presets a slice takes. */
export interface EnginePresets { machine: Config; process: Config; filaments: Config[] }

/** One object of the plate in bed coordinates (mm, +Z up, resting on z = 0). */
export interface EngineObject {
  name: string
  positions: Float32Array
  indices: Uint32Array
  /** filament slot per triangle (1-based, 0 = the object's own), the same list the 3MF writer takes */
  slots?: Uint8Array
}

export interface EnginePlate { objects: EngineObject[] }

export interface LoadProgress { loadedBytes: number; totalBytes: number; done: boolean }

export interface SliceOutput {
  gcode: Uint8Array
  stats: GcodeStats
  toolpaths: Toolpaths | null
  warnings: EngineWarning[]
  /** engine-side milliseconds: load (inside the first slice), slice, export */
  timings: { load: number; slice: number; export: number; total: number }
  heapBytes?: number
}

export interface SlicerEngine {
  /** Download and start the engine. Safe to call again: it resolves with the first result. Reports `initMs` once ready. */
  load(onProgress?: (p: LoadProgress) => void): Promise<{ variant: string; initMs: number }>
  slice(plate: EnginePlate, presets: EnginePresets, onProgress?: (percent: number, message: string) => void): Promise<SliceOutput>
  /** Stop a running slice. The engine is synchronous, so this ends the worker; the next call loads a fresh one. */
  cancel(): void
}
