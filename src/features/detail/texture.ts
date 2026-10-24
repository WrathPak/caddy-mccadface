/** Surface texture: tileable patterns or a picture as a height map, applied to the selected faces as real geometry. */
import { GridNine } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { TextureOpArgs, TexturePreview } from '@/kernel/detail-ops'
import type { Body } from '@/kernel/types'
import { heightImageOf, PATTERNS } from '@/kernel/texture/patterns'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValue, ParamValues } from '@/ui/schema'
import { clearPreview, setPreview } from '@/viewport/preview'
import { createRunner } from '../previewKit'
import { regionFromSelection } from '../hair/region'
import { bindRegion, decodeImage, surfaceOf } from './common'
import { clearDetailView, useDetailView } from './store'

export interface TextureValues {
  region: string[]
  pattern: string
  image: string
  imageName: string
  imageInvert: boolean
  mirror: boolean
  scale: number
  depth: number
  direction: 'out' | 'in' | 'both'
  blend: number
  projection: 'triplanar' | 'uv'
  rotation: number
  offsetU: number
  offsetV: number
  detail: number
}

const BASE: Record<string, ParamValue> = { direction: 'out', blend: 1.5, projection: 'uv', rotation: 0 }
const preset = (over: Record<string, ParamValue>) => ({ ...BASE, ...over })

export const TEXTURE_PRESETS = [
  { id: 'knurl', label: 'Knurled grip', help: 'Diamond knurling like a tool handle or knob. Raised pyramids you can feel.', values: preset({ pattern: 'knurl', scale: 2.4, depth: 0.7 }) },
  { id: 'plate', label: 'Diamond plate', help: 'Raised lozenges like steel tread plate. A good anti-slip surface.', values: preset({ pattern: 'diamond', scale: 7, depth: 0.8 }) },
  { id: 'leather', label: 'Leather', help: 'Soft, cell-like leather grain. Looks best with a small depth.', values: preset({ pattern: 'leather', scale: 5, depth: 0.45, projection: 'triplanar' }) },
  { id: 'honeycomb', label: 'Honeycomb', help: 'Hexagons with narrow grooves, like a honeycomb or a carbon-fibre mesh.', values: preset({ pattern: 'hex', scale: 6, depth: 0.7 }) },
  { id: 'wood', label: 'Wood grain', help: 'Long wavy grain lines. The grain runs along the part when you use the default rotation.', values: preset({ pattern: 'wood', scale: 18, depth: 0.6, direction: 'in', projection: 'triplanar' }) },
  { id: 'carbon', label: 'Carbon weave', help: 'Woven tows passing over and under each other.', values: preset({ pattern: 'carbon', scale: 5, depth: 0.5 }) },
  { id: 'scales', label: 'Scales', help: 'Rows of overlapping rounded scales as a surface texture. Use the Scales tool for scales you can see in profile.', values: preset({ pattern: 'scales', scale: 6, depth: 0.9 }) },
] as const

const patternOptions = [...PATTERNS.map((p) => ({ value: p.id, label: p.label, desc: p.help })), { value: 'image', label: 'Picture (height map)', desc: 'Use your own picture: bright is high, dark is low.' }]

export const textureSchema: ParamSchema = {
  id: 'texture',
  title: 'Texture',
  params: [
    { type: 'selection-ref', key: 'region', label: 'Surface', accepts: ['face'], multiple: true, required: true, default: [], help: 'The faces to texture. Click faces in the viewport, or use the Face, Brush and Fill tools to paint an area.' },
    { type: 'preset', key: 'preset', label: 'Presets', default: 'knurl', presets: TEXTURE_PRESETS.map((p) => ({ id: p.id, label: p.label, help: p.help, values: p.values })), help: 'Start from a ready-made texture. This fills in the settings below; you can still change any of them.' },
    {
      type: 'group', id: 'pattern', label: 'Pattern', help: 'The shape of the texture.', children: [
        { type: 'enum', key: 'pattern', label: 'Pattern', display: 'select', default: 'knurl', options: patternOptions.map((o) => ({ value: o.value, label: o.label })), help: 'Choose a built-in pattern, or a picture of your own to use as a height map. All patterns tile without seams.' },
        { type: 'file', key: 'image', nameKey: 'imageName', label: 'Picture', accept: '.png,.jpg,.jpeg,.webp,.gif', default: '', visibleWhen: (v) => v.pattern === 'image', help: 'The picture to use. Bright pixels become high, dark pixels low. It is saved inside your project.' },
        { type: 'text', key: 'imageName', label: 'Picture name', default: '', visibleWhen: () => false, help: 'Remembers the name of the chosen picture.' },
        { type: 'bool', key: 'imageInvert', label: 'Dark is high', default: false, visibleWhen: (v) => v.pattern === 'image', help: 'Flips the picture so dark pixels are high and bright pixels low.' },
        { type: 'bool', key: 'mirror', label: 'Mirror tiles', default: true, visibleWhen: (v) => v.pattern === 'image', help: 'When the picture repeats, every other copy is flipped so the edges match. Turn off to repeat it as it is.' },
      ],
    },
    {
      type: 'group', id: 'size', label: 'Size and depth', help: 'How big the pattern is and how far it reaches.', children: [
        { type: 'number', key: 'scale', label: 'Pattern size', unit: 'mm', min: 0.3, step: 0.5, default: 2.4, help: 'Size of one repeat of the pattern. On a round face it is adjusted slightly so a whole number of repeats fit around.' },
        { type: 'number', key: 'depth', label: 'Depth', unit: 'mm', min: 0.05, step: 0.1, default: 0.7, help: 'How far the pattern reaches from the surface at its highest. Very deep patterns on small features can fold over themselves.' },
        { type: 'enum', key: 'direction', label: 'Direction', display: 'segmented', default: 'out', options: [{ value: 'out', label: 'Raised' }, { value: 'in', label: 'Cut in' }, { value: 'both', label: 'Both' }], help: 'Raised pushes the pattern out of the surface, Cut in pushes it into the part, Both goes half each way around the original surface.' },
        { type: 'number', key: 'blend', label: 'Edge fade', unit: 'mm', min: 0, step: 0.5, default: 1.5, help: 'Distance over which the texture fades out toward the edge of the selected faces, so it joins the rest of the model cleanly. 0 runs the texture right up to the edge.' },
      ],
    },
    {
      type: 'group', id: 'mapping', label: 'Mapping', collapsed: true, help: 'How the pattern is laid onto the surface.', children: [
        { type: 'enum', key: 'projection', label: 'Projection', display: 'segmented', default: 'uv', options: [{ value: 'uv', label: 'Follow faces' }, { value: 'triplanar', label: 'Triplanar' }], help: 'Follow faces lays flat faces flat and wraps round faces around them with a whole number of repeats. Triplanar projects from three directions and suits organic shapes.' },
        { type: 'number', key: 'rotation', label: 'Rotation', unit: 'deg', step: 15, default: 0, help: 'Turns the pattern. On round faces only quarter turns are used so the pattern closes around the part.' },
        { type: 'number', key: 'offsetU', label: 'Shift across', unit: 'mm', step: 0.5, default: 0, help: 'Slides the pattern sideways across the surface.' },
        { type: 'number', key: 'offsetV', label: 'Shift along', unit: 'mm', step: 0.5, default: 0, help: 'Slides the pattern up and down the surface.' },
      ],
    },
    {
      type: 'group', id: 'quality', label: 'Quality', collapsed: true, help: 'Mesh detail.', children: [
        { type: 'number', key: 'detail', label: 'Mesh detail', unit: 'mm', min: 0, step: 0.1, default: 0, help: 'Edge length of the triangles in the textured area. 0 picks a size from the pattern. The preview uses a coarser mesh; the final result uses this value.' },
      ],
    },
  ],
}

const MAX_TRIS = 1_500_000

async function textureArgs(v: TextureValues, bodies: Body[], blob: (id: string) => Uint8Array | undefined, preview: boolean): Promise<{ args: TextureOpArgs; body: Body }> {
  const { rs } = surfaceOf(v.region, bodies, 'texture')
  let pattern: TextureOpArgs['pattern']
  if (v.pattern === 'image') {
    const bytes = v.image ? blob(v.image) : undefined
    if (!bytes) throw new Error('Choose a picture to use as the height map')
    const r = await decodeImage(v.image, bytes, 256)
    pattern = { image: heightImageOf(r.rgba, r.w, r.h, v.imageInvert), mirror: v.mirror }
  } else pattern = { id: v.pattern as never }
  const args: TextureOpArgs = {
    pattern, key: rs.body.key, kind: rs.kind, region: [...rs.set], preview,
    scale: v.scale, depth: v.depth, direction: v.direction, rotation: v.rotation, offsetU: v.offsetU, offsetV: v.offsetV, blend: v.blend,
    projection: v.projection, detail: v.detail, maxTris: MAX_TRIS,
  }
  return { args, body: rs.body }
}

registerFeature({
  type: 'texture',
  label: 'Texture',
  icon: GridNine,
  schema: textureSchema,
  async compute(ctx, raw) {
    const { args, body } = await textureArgs(raw as unknown as TextureValues, ctx.bodies, ctx.blob, false)
    const r = (await ctx.kernel.call('textureFace', { ...args, id: body.id, name: body.name })) as { bodies: Body[]; warnings: string[] }
    return { bodies: r.bodies, warning: r.warnings.length ? r.warnings.join('. ') : undefined }
  },
  preview: (ctx) => texturePreview(ctx),
})

function texturePreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur: ParamValues = values
  let hidden: string | null = null
  const geometry = () => useDoc.getState().geometry
  const faces = bindRegion((region) => { cur = { ...cur, region }; setValues(cur) }, (cur.region as string[]).length ? 'off' : 'brush')
  faces.show(cur.region as string[])
  const showBody = (id: string | null) => {
    if (id === hidden) return
    hidden = id
    if (id) setPreview([], [id]); else clearPreview()
  }
  const runner = createRunner(async (stale) => {
    try {
      const v = resolveParams(textureSchema, cur) as unknown as TextureValues
      if (!v.region.length) { showBody(null); useDetailView.setState({ texture: null, readout: null, busy: false }); useUi.setState({ inspectorNotice: null }); return }
      useDetailView.setState({ busy: true })
      const blobs = useDoc.getState().blobs
      const { args, body } = await textureArgs(v, geometry(), (id) => blobs[id], true)
      const res = (await getKernel().call('textureFace', args)) as TexturePreview
      if (stale()) return
      showBody(body.id)
      useDetailView.setState({
        texture: { mesh: res.mesh, bodyId: body.id },
        readout: `Preview at ${res.stats.edgeLength.toFixed(2)} mm detail, ${Math.round(res.stats.triangles / 1000)}k triangles. The final model uses full detail.${res.warnings.length ? ' | ' + res.warnings.join('. ') : ''}`,
        busy: false,
      })
      useUi.setState({ inspectorNotice: null })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!stale()) { showBody(null); useDetailView.setState({ texture: null, readout: null, busy: false }); useUi.setState({ inspectorNotice: msg }) }
    }
  }, 260)
  runner.schedule()
  return {
    update(v) {
      cur = v
      faces.sync(v.region as string[])
      runner.schedule()
    },
    dispose() {
      runner.dispose()
      faces.dispose()
      clearPreview()
      clearDetailView()
      useUi.setState({ inspectorNotice: null })
    },
  }
}

export function startTexture() {
  const region = regionFromSelection(useUi.getState().selection, useDoc.getState().geometry)
  createFeature('texture', { region }, 'detail.texture')
}
