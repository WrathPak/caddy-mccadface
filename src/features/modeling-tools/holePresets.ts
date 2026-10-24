/** Common screw sizes for the Hole tool: clearance, counterbore, countersink, tapped and heat-set insert holes (mm). */
import type { ParamValue } from '@/ui/schema'

interface Screw {
  name: string
  /** nominal diameter */
  major: number
  pitch: number
  /** normal-fit clearance hole */
  clearance: number
  /** socket head cap screw: counterbore diameter and depth */
  cbDia: number
  cbDepth: number
  /** flat head: countersink diameter */
  cskDia: number
  /** heat-set insert for 3D printing: hole diameter and depth */
  insertDia: number
  insertDepth: number
}

export const SCREWS: Screw[] = [
  { name: 'M2', major: 2, pitch: 0.4, clearance: 2.4, cbDia: 4.4, cbDepth: 2.4, cskDia: 4.4, insertDia: 3.2, insertDepth: 4 },
  { name: 'M2.5', major: 2.5, pitch: 0.45, clearance: 2.9, cbDia: 5.4, cbDepth: 2.9, cskDia: 5.5, insertDia: 3.6, insertDepth: 5 },
  { name: 'M3', major: 3, pitch: 0.5, clearance: 3.4, cbDia: 6.5, cbDepth: 3.4, cskDia: 6.3, insertDia: 4.2, insertDepth: 5.7 },
  { name: 'M4', major: 4, pitch: 0.7, clearance: 4.5, cbDia: 8.2, cbDepth: 4.4, cskDia: 8.4, insertDia: 5.6, insertDepth: 8.1 },
  { name: 'M5', major: 5, pitch: 0.8, clearance: 5.5, cbDia: 9.8, cbDepth: 5.4, cskDia: 10.4, insertDia: 6.4, insertDepth: 9.5 },
  { name: 'M6', major: 6, pitch: 1, clearance: 6.6, cbDia: 11.5, cbDepth: 6.4, cskDia: 12.6, insertDia: 8, insertDepth: 12.7 },
  { name: 'M8', major: 8, pitch: 1.25, clearance: 9, cbDia: 14.5, cbDepth: 8.4, cskDia: 16.6, insertDia: 9.6, insertDepth: 12.7 },
  { name: 'M10', major: 10, pitch: 1.5, clearance: 11, cbDia: 18, cbDepth: 10.4, cskDia: 20.8, insertDia: 12, insertDepth: 15 },
  { name: 'M12', major: 12, pitch: 1.75, clearance: 13.5, cbDia: 20, cbDepth: 12.4, cskDia: 24, insertDia: 14, insertDepth: 18 },
]

/** Tap drill (minor diameter) of an ISO metric thread. */
export const tapDrill = (major: number, pitch: number) => +(major - 1.0825 * pitch).toFixed(2)

type Values = Record<string, ParamValue>
export interface HolePreset { id: string; label: string; help: string; values: Values }

const base: Values = { holeType: 'simple', tapType: 'simple', depthMode: 'depth', cskAngle: 90, tip: 0 }

/** The presets of the Hole dialog: pick one and the fields below are filled in (edit them afterwards if needed). */
export const HOLE_PRESETS: HolePreset[] = [
  { id: 'custom', label: 'Custom', help: 'Type the sizes yourself.', values: {} },
  ...SCREWS.flatMap((s): HolePreset[] => [
    { id: `${s.name}-clearance`, label: `${s.name} clearance, ${s.clearance} mm`, help: `A through hole a ${s.name} screw slides through.`, values: { ...base, dia: s.clearance, depthMode: 'through' } },
    { id: `${s.name}-cbore`, label: `${s.name} counterbore`, help: `Clearance hole with a ${s.cbDia} mm counterbore, ${s.cbDepth} mm deep, for a socket head cap screw.`, values: { ...base, holeType: 'cbore', dia: s.clearance, cbDia: s.cbDia, cbDepth: s.cbDepth, depthMode: 'through' } },
    { id: `${s.name}-csink`, label: `${s.name} countersink`, help: `Clearance hole with a 90 degree countersink ${s.cskDia} mm wide.`, values: { ...base, holeType: 'csink', dia: s.clearance, cskDia: s.cskDia, cskAngle: 90, depthMode: 'through' } },
    {
      id: `${s.name}-tapped`, label: `${s.name} x ${s.pitch} tapped`, help: `Tap drill ${tapDrill(s.major, s.pitch)} mm with a ${s.name} x ${s.pitch} thread. The thread is a cosmetic mark unless you switch on Model the thread.`,
      values: { ...base, tapType: 'tapped', major: s.major, pitch: s.pitch, dia: tapDrill(s.major, s.pitch), depth: Math.round(s.major * 2.5), threadLength: Math.round(s.major * 2), tip: 118 },
    },
    { id: `${s.name}-insert`, label: `${s.name} heat-set insert`, help: `Blind hole for a ${s.name} brass heat-set insert in a 3D print: ${s.insertDia} mm wide, ${s.insertDepth} mm deep. Check the figures against your inserts.`, values: { ...base, dia: s.insertDia, depth: s.insertDepth, depthMode: 'depth', tip: 0 } },
  ]),
]
