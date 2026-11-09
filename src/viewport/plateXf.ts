/**
 * Where the bodies stand on the print bed while the Print workspace is open. The print feature fills it in; the viewport reads it
 * (it draws each body through this matrix, like an assembly placement) without knowing anything about printing.
 */
import { create } from 'zustand'
import type { Vec3 } from '@/kernel/types'

export interface PlateXf {
  /** CAD space to the bed, per body id, column-major; null when no plate is shown (every other workspace) */
  worlds: Record<string, number[]> | null
  /** the part on the bed, per body id */
  boxes: Record<string, { lo: Vec3; hi: Vec3 }> | null
  /** parts that do not fit the bed: drawn in the warning color */
  bad: Record<string, true>
  /** the Print workspace picks faces itself (Lay on face): the bodies neither hover-tint nor select on a click */
  facePick?: boolean
}

export const usePlateXf = create<PlateXf>(() => ({ worlds: null, boxes: null, bad: {} }))
