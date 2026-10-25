import { beforeAll, describe, expect, it } from 'vitest'
import { box, initOcc } from '@/kernel/occ'
import { bodyFromShape } from '@/kernel/store'
import { encodeRef, refFromSelection } from '@/doc/refs'
import type { Feature } from '@/doc/types'
import { appearanceSchema, computeAppearanceMap, specForFace } from './appearanceMap'
import { denoise } from './denoise'
import { ENVIRONMENTS, envPixels } from './envmap'
import { PRESETS, effectivePreset, parseHex, presetById, specKey } from './presets'
import { boxUvs, buildModel, faceGeometry, lookGroups, makeMaterial } from './sceneBuild'
import { DEFAULT_SETTINGS, fovForFocal, normalizeSettings, settingsToJson } from './settingsCore'
import { carbonTexture, woodTexture } from './textures'
import { apertureSamples } from './renderer'
import { focusRange } from './RenderScene'

beforeAll(async () => { await initOcc() })

describe('material presets', () => {
  it('has the eight required materials with unique ids', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['pla', 'petg', 'silk', 'metal', 'wood', 'glass', 'rubber', 'carbon'])
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length)
  })
  it('every preset gives valid physical material parameters', () => {
    for (const p of PRESETS) {
      expect(parseHex(p.color), p.id).not.toBeNull()
      expect(parseHex(p.sheenColor), p.id).not.toBeNull()
      for (const k of ['roughness', 'metalness', 'transmission', 'clearcoat', 'clearcoatRoughness', 'sheen', 'sheenRoughness', 'iridescence'] as const) {
        expect(p[k], `${p.id}.${k}`).toBeGreaterThanOrEqual(0)
        expect(p[k], `${p.id}.${k}`).toBeLessThanOrEqual(1)
      }
      expect(p.ior).toBeGreaterThanOrEqual(1)
      expect(p.tileMm).toBeGreaterThan(0)
      const m = makeMaterial({ material: p.id, color: '' })
      expect(m.roughness).toBeCloseTo(p.roughness)
      expect(m.metalness).toBeCloseTo(p.metalness)
      expect(m.transmission).toBeCloseTo(p.transmission)
      expect(!!m.map, p.id).toBe(p.texture !== null)
      expect(!!m.normalMap, p.id).toBe(p.texture === 'carbon')
      m.dispose()
    }
  })
  it('glass is see-through in the viewport and refracts in renders', () => {
    const live = makeMaterial({ material: 'glass', color: '' }, true)
    const final = makeMaterial({ material: 'glass', color: '' }, false)
    expect(live.transmission).toBe(0)
    expect(live.transparent).toBe(true)
    expect(final.transmission).toBe(1)
  })
  it('a color override replaces the preset color, bad colors are ignored', () => {
    expect(effectivePreset({ material: 'petg', color: '#FF0000' }).color).toBe('#ff0000')
    expect(effectivePreset({ material: 'petg', color: 'red' }).color).toBe(presetById('petg').color)
    expect(specKey({ material: 'nope', color: '' })).toBe('pla|')
  })
})

describe('procedural textures', () => {
  it('are deterministic and tile', () => {
    expect(woodTexture(64).data).toEqual(woodTexture(64).data)
    const a = carbonTexture(64), b = carbonTexture(64)
    expect(a.color.data).toEqual(b.color.data)
    expect(a.normal.data).toEqual(b.normal.data)
  })
  it('have real variation and opaque pixels', () => {
    for (const t of [woodTexture(64), carbonTexture(64).color, carbonTexture(64).normal]) {
      let lo = 255, hi = 0
      for (let i = 0; i < t.data.length; i += 4) {
        expect(t.data[i + 3]).toBe(255)
        lo = Math.min(lo, t.data[i]); hi = Math.max(hi, t.data[i])
      }
      expect(hi - lo).toBeGreaterThan(20)
    }
  })
  it('carbon normals point out of the surface', () => {
    const n = carbonTexture(64).normal
    for (let i = 0; i < n.data.length; i += 4) expect(n.data[i + 2]).toBeGreaterThan(127)
  })
})

describe('environments', () => {
  it('every environment is a finite, non-black HDR image with some bright parts', () => {
    for (const e of ENVIRONMENTS) {
      const px = envPixels(e.id, 64, 32)
      let max = 0, sum = 0
      for (let i = 0; i < px.length; i += 4) {
        expect(Number.isFinite(px[i] + px[i + 1] + px[i + 2])).toBe(true)
        max = Math.max(max, px[i]); sum += px[i]
      }
      expect(sum, e.id).toBeGreaterThan(0)
      expect(max, e.id).toBeGreaterThan(0.5)
    }
  })
  it('the studio key light sits above the horizon (+Y up in the image)', () => {
    const w = 64, h = 32
    const px = envPixels('studio', w, h)
    let best = 0, row = 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = px[(y * w + x) * 4]; if (v > best) { best = v; row = y } }
    expect(row).toBeGreaterThan(h / 2) // rows count up from the bottom
  })
})

describe('settings', () => {
  it('round trip through json and sanitise bad input', () => {
    const s = normalizeSettings({ ...DEFAULT_SETTINGS, env: 'sunset', focalMm: 85, dof: true, width: 800, turntable: { seconds: 6, fps: 30, width: 320, height: 240 } })
    expect(normalizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s)
    expect(s.env).toBe('sunset')
    const bad = normalizeSettings({ env: 'nope', focalMm: -5, samples: 1e9, width: 'x', backdropColor: 'blue', engine: 'gpu' })
    expect(bad.env).toBe(DEFAULT_SETTINGS.env)
    expect(bad.focalMm).toBe(14)
    expect(bad.samples).toBe(4096)
    expect(bad.width).toBe(DEFAULT_SETTINGS.width)
    expect(bad.backdropColor).toBe(DEFAULT_SETTINGS.backdropColor)
    expect(bad.engine).toBe('auto')
  })
  it('default settings leave no file in the project', () => {
    expect(settingsToJson(DEFAULT_SETTINGS)).toBeNull()
    expect(settingsToJson({ ...DEFAULT_SETTINGS, samples: 8 })).not.toBeNull()
  })
  it('focal length maps to a full frame field of view', () => {
    expect(fovForFocal(50)).toBeCloseTo(26.99, 1)
    expect(fovForFocal(24)).toBeGreaterThan(fovForFocal(50))
  })
})

describe('camera', () => {
  it('lens samples stay inside the aperture and are spread out', () => {
    const s = apertureSamples(32)
    expect(s).toHaveLength(32)
    for (const [x, y] of s) expect(Math.hypot(x, y)).toBeLessThanOrEqual(1)
    const mean = s.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]).map((v) => v / 32)
    expect(Math.hypot(mean[0], mean[1])).toBeLessThan(0.15)
  })
  it('a wider aperture keeps less in focus', () => {
    expect(focusRange(50, 2, 300)).toBeLessThan(focusRange(50, 11, 300))
  })
})

describe('denoise', () => {
  const W = 48, H = 32
  /** left half dark, right half bright, plus deterministic noise */
  function noisyEdge(amp: number) {
    const data = new Uint8ClampedArray(W * H * 4)
    let seed = 7
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5 }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const base = x < W / 2 ? 60 : 200
      const i = (y * W + x) * 4
      for (let k = 0; k < 3; k++) data[i + k] = Math.max(0, Math.min(255, base + rnd() * amp))
      data[i + 3] = 255
    }
    return { width: W, height: H, data }
  }
  const variance = (d: Uint8ClampedArray, x0: number, x1: number) => {
    let n = 0, s = 0, s2 = 0
    for (let y = 2; y < H - 2; y++) for (let x = x0; x < x1; x++) { const v = d[(y * W + x) * 4]; n++; s += v; s2 += v * v }
    return s2 / n - (s / n) ** 2
  }
  it('removes noise from flat areas', () => {
    const img = noisyEdge(60)
    const out = denoise(img, 0.5)
    expect(variance(out, 4, 18)).toBeLessThan(variance(img.data as Uint8ClampedArray, 4, 18) * 0.3)
    expect(variance(out, 30, 44)).toBeLessThan(variance(img.data as Uint8ClampedArray, 30, 44) * 0.3)
  })
  it('keeps the edge between the halves sharp', () => {
    const out = denoise(noisyEdge(40), 0.5)
    const left = out[(16 * W + W / 2 - 2) * 4], right = out[(16 * W + W / 2 + 1) * 4]
    expect(right - left).toBeGreaterThan(110)
  })
  it('is deterministic and keeps alpha', () => {
    const img = noisyEdge(50)
    expect(denoise(img, 0.5)).toEqual(denoise(img, 0.5))
    expect(denoise(img)[3]).toBe(255)
  })
  it('leaves a clean image almost untouched', () => {
    const img = noisyEdge(0)
    const out = denoise(img, 0.5)
    for (let i = 0; i < out.length; i += 4) expect(Math.abs(out[i] - img.data[i])).toBeLessThanOrEqual(2)
  })
})

describe('appearance map', () => {
  const cube = () => bodyFromShape('b1', 'Cube', box([20, 20, 20], [0, 0, 0]))
  const refOf = (b: ReturnType<typeof cube>, face: number) => encodeRef(refFromSelection({ kind: 'face', id: b.id, index: face }, [b])!)
  const bodyRef = (b: ReturnType<typeof cube>) => encodeRef(refFromSelection({ kind: 'body', id: b.id }, [b])!)
  const feat = (id: string, targets: string[], material: string, color = ''): Feature => ({
    id, type: 'appearance', name: id, state: 'ok', suppressed: false, params: { targets, material, color },
  })

  it('a body gets a default and a face overrides it', () => {
    const b = cube()
    const m = computeAppearanceMap([feat('f1', [bodyRef(b)], 'metal'), feat('f2', [refOf(b, 2)], 'wood')], 2, [b])
    const e = m.get('b1')!
    expect(e.body?.material).toBe('metal')
    expect(specForFace(e, 2)?.material).toBe('wood')
    expect(specForFace(e, 0)?.material).toBe('metal')
  })
  it('later assignments win, and a later body assignment replaces earlier face ones', () => {
    const b = cube()
    const faceThenBody = computeAppearanceMap([feat('f1', [refOf(b, 1)], 'wood'), feat('f2', [bodyRef(b)], 'rubber')], 2, [b])
    expect(specForFace(faceThenBody.get('b1'), 1)?.material).toBe('rubber')
    const twice = computeAppearanceMap([feat('f1', [refOf(b, 1)], 'wood'), feat('f2', [refOf(b, 1)], 'glass', '#00ff00')], 2, [b])
    expect(specForFace(twice.get('b1'), 1)).toEqual({ material: 'glass', color: '#00ff00' })
  })
  it('ignores suppressed features and features past the rollback marker', () => {
    const b = cube()
    const a = feat('f1', [bodyRef(b)], 'petg')
    expect(computeAppearanceMap([{ ...a, suppressed: true }], 1, [b]).size).toBe(0)
    expect(computeAppearanceMap([a], 0, [b]).size).toBe(0)
  })
  it('skips targets that are gone', () => {
    const b = cube()
    expect(computeAppearanceMap([feat('f1', ['missing'], 'petg')], 1, [b]).size).toBe(0)
  })
  it('the schema asks for targets, a material and a color', () => {
    expect(appearanceSchema.params.map((p) => ('key' in p ? p.key : ''))).toEqual(['targets', 'material', 'color'])
  })

  it('groups faces by look and builds one mesh per look with UVs', () => {
    const b = cube()
    const m = computeAppearanceMap([feat('f1', [refOf(b, 2)], 'wood')], 1, [b])
    const groups = lookGroups(b, m.get('b1'))
    expect(groups.map((g) => g.spec?.material ?? 'rest').sort()).toEqual(['rest', 'wood'])
    const model = buildModel([b], { appearance: m, hidden: {}, fallback: { material: 'pla', color: '' } })
    expect(model.children).toHaveLength(2)
    let tris = 0
    for (const c of model.children) {
      const geo = (c as unknown as { geometry: { getAttribute(n: string): { count: number } } }).geometry
      expect(geo.getAttribute('uv').count).toBe(geo.getAttribute('position').count)
      tris += geo.getAttribute('position').count / 3
    }
    expect(tris).toBe(b.mesh.indices.length / 3)
    const only = buildModel([b], { appearance: m, hidden: {}, onlyAssigned: true, fallback: { material: 'pla', color: '' } })
    expect(only.children).toHaveLength(1)
    expect(buildModel([b], { appearance: m, hidden: { b1: true }, fallback: { material: 'pla', color: '' } }).children).toHaveLength(0)
  })
  it('face geometry holds exactly the triangles of the chosen faces', () => {
    const b = cube()
    const g = faceGeometry(b, (f) => f === 0)!
    const want = [...b.mesh.faceIds].filter((f) => f === 0).length
    expect(g.getAttribute('position').count / 3).toBe(want)
    expect(faceGeometry(b, () => false)).toBeNull()
  })
  it('box UVs flatten each triangle along its dominant axis', () => {
    // one triangle in the XY plane (normal along Z): uv = (x, y) / tile
    const uv = boxUvs(new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0]), 10)
    expect(Array.from(uv)).toEqual([0, 0, 1, 0, 0, 2])
  })
})
