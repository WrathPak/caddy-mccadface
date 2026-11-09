/**
 * Which filament prints each toolpath segment. The engine's toolpaths carry no extruder, so the G-code is scanned for tool
 * changes: every time a new tool starts extruding, the spot it starts from is recorded, and the segments are cut there.
 * (Matching by position, not by index: the engine splits arcs into several segments, so line counts do not line up.)
 */

export interface FilamentRun {
  /** 0-based tool (extruder) */
  tool: number
  /** where the first extrusion with this tool starts, bed coordinates */
  start: [number, number, number]
}

export interface GcodeScan {
  runs: FilamentRun[]
  /** from the footer, one entry per filament; null when the file has no such line */
  usedMm: number[] | null
  usedG: number[] | null
}

const num = (s: string, key: string): number | null => {
  const i = s.indexOf(key)
  if (i < 0) return null
  let j = i + 1
  while (j < s.length && ' \t'.includes(s[j])) j++
  let k = j
  while (k < s.length && '+-.0123456789eE'.includes(s[k])) k++
  const v = parseFloat(s.slice(j, k))
  return Number.isFinite(v) ? v : null
}

/** A word's number: the value after the letter, only when the letter starts a word (so "E" is not found inside a comment). */
function word(line: string, letter: string): number | null {
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i)
    if (c === 59) return null // ';' comment starts
    if (line[i] === letter && line.charCodeAt(i - 1) <= 32) return num(line.slice(i), letter)
  }
  return null
}

const list = (line: string): number[] | null => {
  const eq = line.indexOf('=')
  if (eq < 0) return null
  const v = line.slice(eq + 1).split(',').map((s) => parseFloat(s))
  return v.length && v.every(Number.isFinite) ? v : null
}

export function scanGcode(gcode: Uint8Array | string): GcodeScan {
  const text = typeof gcode === 'string' ? gcode : new TextDecoder().decode(gcode)
  const runs: FilamentRun[] = []
  let usedMm: number[] | null = null
  let usedG: number[] | null = null
  let x = 0, y = 0, z = 0, e = 0
  let rel = false // M83: E values are steps
  let relXyz = false // G91
  let tool = 0
  let runTool = -1
  let pos = 0
  const n = text.length
  while (pos < n) {
    let end = text.indexOf('\n', pos)
    if (end < 0) end = n
    const line = text.charCodeAt(end - 1) === 13 ? text.slice(pos, end - 1) : text.slice(pos, end)
    pos = end + 1
    const c0 = line.charCodeAt(0)
    if (c0 === 71 /* G */) {
      const c1 = line.charCodeAt(1)
      const c2 = line.charCodeAt(2)
      if (c1 === 57 && c2 === 50 && line.charCodeAt(3) <= 32) { // G92
        const v = word(line, 'E')
        if (v !== null) e = v
        continue
      }
      if (c1 === 57 && c2 === 49) { relXyz = true; continue }
      if (c1 === 57 && c2 === 48) { relXyz = false; continue }
      if (c1 >= 48 && c1 <= 51 && c2 <= 32) {
        const nx = word(line, 'X'), ny = word(line, 'Y'), nz = word(line, 'Z'), ne = word(line, 'E')
        const px = x, py = y, pz = z
        if (nx !== null) x = relXyz ? x + nx : nx
        if (ny !== null) y = relXyz ? y + ny : ny
        if (nz !== null) z = relXyz ? z + nz : nz
        if (ne !== null) {
          const de = rel ? ne : ne - e
          e = rel ? e + ne : ne
          if (de > 0 && (x !== px || y !== py) && c1 !== 48) {
            if (runTool !== tool) {
              runs.push({ tool, start: [px, py, pz] })
              runTool = tool
            }
          }
        }
      }
    } else if (c0 === 84 /* T */) {
      const m = /^T(\d+)\s*(;.*)?$/.exec(line)
      // Bambu's T1000 / T255 and friends are not extruders
      if (m && +m[1] < 32) tool = +m[1]
    } else if (c0 === 77 /* M */) {
      if (line.startsWith('M83')) rel = true
      else if (line.startsWith('M82')) rel = false
    } else if (c0 === 59 /* ; */) {
      if (line.startsWith('; filament used [mm]')) usedMm = list(line)
      else if (line.startsWith('; filament used [g]')) usedG = list(line)
    }
  }
  return { runs, usedMm, usedG }
}

/** Filament index per extrusion segment from the scanned runs; positions are 6 floats a segment. */
export function assignFilaments(positions: Float32Array, count: number, runs: FilamentRun[], tol = 0.01, window = 60_000): Uint8Array {
  const out = new Uint8Array(count)
  if (runs.length < 2) {
    if (runs.length === 1) out.fill(runs[0].tool)
    return out
  }
  let at = 0
  let tool = runs[0].tool
  for (let r = 1; r < runs.length; r++) {
    const s = runs[r].start
    const stop = Math.min(count, at + window)
    let found = -1
    for (let i = at; i < stop; i++) {
      const o = i * 6
      if (Math.abs(positions[o] - s[0]) < tol && Math.abs(positions[o + 1] - s[1]) < tol && Math.abs(positions[o + 2] - s[2]) < tol) { found = i; break }
    }
    if (found < 0) continue // could not place this change: keep the previous filament going
    if (found > at) out.fill(tool, at, found)
    at = found
    tool = runs[r].tool
  }
  out.fill(tool, at, count)
  return out
}
