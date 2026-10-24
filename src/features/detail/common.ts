/** Pieces shared by the DETAIL features: the selected surface, its face tools, image decoding. */
import { useDoc } from '@/doc/store'
import type { Body } from '@/kernel/types'
import type { ParamValues } from '@/ui/schema'
import { loadSelection, setPaint, type PaintMode } from '../hair/paint'
import { extractRegion, resolveRegionSet, type RegionSet } from '../hair/region'

type V3 = [number, number, number]

/** The faces a dialog works on, resolved against the current bodies. Throws a readable error when there are none. */
export function surfaceOf(region: string[], bodies: Body[], what: string): { rs: RegionSet; positions: Float32Array; indices: Uint32Array } {
  const rs = resolveRegionSet(region, bodies)
  if (!rs) throw new Error(`Select the surface for the ${what} (click faces, or use the Face, Brush and Fill tools)`)
  const { positions, indices } = extractRegion(rs)
  if (!positions.length) throw new Error('The selected surface is empty')
  return { rs, positions, indices }
}

/** Area weighted centre of a triangle soup. */
export function centroidOf(positions: Float32Array, indices: Uint32Array): V3 {
  let x = 0, y = 0, z = 0, a = 0
  for (let t = 0; t < indices.length; t += 3) {
    const i = indices[t] * 3, j = indices[t + 1] * 3, k = indices[t + 2] * 3
    const ux = positions[j] - positions[i], uy = positions[j + 1] - positions[i + 1], uz = positions[j + 2] - positions[i + 2]
    const vx = positions[k] - positions[i], vy = positions[k + 1] - positions[i + 1], vz = positions[k + 2] - positions[i + 2]
    const w = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
    x += (w * (positions[i] + positions[j] + positions[k])) / 3
    y += (w * (positions[i + 1] + positions[j + 1] + positions[k + 1])) / 3
    z += (w * (positions[i + 2] + positions[j + 2] + positions[k + 2])) / 3
    a += w
  }
  return a ? [+(x / a).toFixed(3), +(y / a).toFixed(3), +(z / a).toFixed(3)] : [0, 0, 0]
}

/**
 * Connects a dialog's `region` value to the Face / Brush / Fill toolbar and the cyan highlight (the same tools the Hair dialog uses).
 * `put` receives the new region whenever a stroke ends; call `sync` with the dialog's region whenever it changes.
 */
export function bindRegion(put: (region: string[]) => void, mode: PaintMode) {
  let last = ''
  setPaint({ visible: true, mode, sink: (region) => { last = region.join('|'); put(region) } })
  const geometry = () => useDoc.getState().geometry
  return {
    sync(region: string[]) {
      const key = region.join('|')
      if (key === last) return
      last = key
      const rs = resolveRegionSet(region, geometry())
      loadSelection(rs?.body.id ?? null, rs?.kind ?? null, rs?.set ?? new Set())
    },
    /** show the current region once at the start */
    show(region: string[]) {
      last = ''
      this.sync(region)
    },
    dispose() {
      setPaint({ visible: false, mode: 'off', sink: null })
      loadSelection(null, null, new Set())
    },
  }
}

export interface Raster { rgba: Uint8ClampedArray; w: number; h: number }
const decoded = new Map<string, Promise<Raster>>()

/** Decode a PNG / JPEG / GIF / WebP (in the browser) to pixels, scaled down so the longest side is at most `maxSide`. */
export function decodeImage(id: string, bytes: Uint8Array, maxSide = 512): Promise<Raster> {
  let p = decoded.get(id)
  if (!p) {
    p = (async () => {
      let bmp: ImageBitmap
      try { bmp = await createImageBitmap(new Blob([bytes as BlobPart])) } catch { throw new Error('This image could not be read. Use a PNG, JPEG, GIF, WebP or SVG file') }
      const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
      const w = Math.max(2, Math.round(bmp.width * k)), h = Math.max(2, Math.round(bmp.height * k))
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const g = canvas.getContext('2d', { willReadFrequently: true })!
      g.drawImage(bmp, 0, 0, w, h)
      bmp.close()
      return { rgba: g.getImageData(0, 0, w, h).data, w, h }
    })()
    p.catch(() => decoded.delete(id))
    decoded.set(id, p)
  }
  return p
}

export const isSvg = (name: string, bytes: Uint8Array) => /\.svg$/i.test(name) || new TextDecoder().decode(bytes.slice(0, 256)).trimStart().startsWith('<')

/** The values a dialog is edited with, as a typed object. */
export const asValues = <T>(v: ParamValues) => v as unknown as T
