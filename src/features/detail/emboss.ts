/** Emboss and engrave: text, SVG logos and pictures laid on a face, including curved ones. */
import { TextAa } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel } from '@/kernel/client'
import type { EmbossOpArgs, EmbossPreview, EmbossSource } from '@/kernel/detail-ops'
import type { Body } from '@/kernel/types'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { createRunner } from '../previewKit'
import { regionFromSelection } from '../hair/region'
import { bindRegion, centroidOf, decodeImage, isSvg, surfaceOf } from './common'
import { DEFAULT_FONT, FONTS, loadFontBytes } from './fonts'
import { clearDetailView, useDetailView } from './store'

type V3 = [number, number, number]

export interface EmbossValues {
  region: string[]
  source: 'text' | 'logo'
  mode: 'emboss' | 'engrave'
  text: string
  font: string
  textSize: number
  letterSpacing: number
  lineSpacing: number
  align: 'left' | 'center' | 'right'
  logo: string
  logoName: string
  logoWidth: number
  invert: boolean
  threshold: number
  depth: number
  weight: number
  pos: V3
  rotation: number
  wrap: 'project' | 'cylinder'
  placed: boolean
  sink: number
  detail: number
}

const isText = (v: ParamValues) => v.source === 'text'
const isLogo = (v: ParamValues) => v.source === 'logo'

export const embossSchema: ParamSchema = {
  id: 'emboss',
  title: 'Text and logos',
  params: [
    { type: 'selection-ref', key: 'region', label: 'Surface', accepts: ['face'], multiple: true, required: true, default: [], help: 'The faces the artwork goes on. Click faces in the viewport, or use the Face, Brush and Fill tools to pick an area. It follows curved faces.' },
    { type: 'enum', key: 'source', label: 'Shape from', display: 'segmented', default: 'text', options: [{ value: 'text', label: 'Text' }, { value: 'logo', label: 'Logo or picture' }], help: 'Type text, or use an SVG logo or a picture (PNG, JPEG, WebP) as the shape.' },
    { type: 'enum', key: 'mode', label: 'Effect', display: 'segmented', default: 'emboss', options: [{ value: 'emboss', label: 'Emboss (raised)' }, { value: 'engrave', label: 'Engrave (cut in)' }], help: 'Emboss raises the artwork out of the surface. Engrave cuts it into the surface.' },
    {
      type: 'group', id: 'artwork', label: 'Artwork', help: 'What to put on the surface: the text and its look, or the file to use as the shape.', children: [
        { type: 'text', key: 'text', label: 'Text', multiline: true, placeholder: 'Type here', default: 'Hello', visibleWhen: isText, help: 'The words to put on the surface. Press Enter for a new line.' },
        { type: 'enum', key: 'font', label: 'Font', display: 'select', default: DEFAULT_FONT, options: FONTS.map((f) => ({ value: f.id, label: f.label })), visibleWhen: isText, help: 'The typeface. All fonts are built into the app, so nothing is downloaded.' },
        { type: 'number', key: 'textSize', label: 'Text height', unit: 'mm', min: 1, step: 1, default: 8, visibleWhen: isText, help: 'Height of a capital letter. Letters below about 4 mm tall are hard to print clearly.' },
        { type: 'enum', key: 'align', label: 'Alignment', display: 'segmented', default: 'center', options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }], visibleWhen: (v) => isText(v) && String(v.text).includes('\n'), help: 'How the lines line up with each other when there is more than one.' },
        { type: 'number', key: 'letterSpacing', label: 'Letter spacing', min: -0.3, step: 0.05, default: 0, visibleWhen: isText, help: 'Extra space between letters, as a fraction of the letter height. 0 uses the font as designed.' },
        { type: 'number', key: 'lineSpacing', label: 'Line spacing', min: 0.5, step: 0.1, default: 1, visibleWhen: (v) => isText(v) && String(v.text).includes('\n'), help: 'Distance between lines. 1 is normal; larger spreads the lines apart.' },
        { type: 'file', key: 'logo', nameKey: 'logoName', label: 'File', accept: '.svg,.png,.jpg,.jpeg,.webp,.gif', default: '', visibleWhen: isLogo, help: 'An SVG is traced exactly (white areas count as empty). A picture is traced from its dark parts. The file is saved inside your project.' },
        { type: 'text', key: 'logoName', label: 'File name', default: '', visibleWhen: () => false, help: 'Remembers the name of the chosen file.' },
        { type: 'number', key: 'logoWidth', label: 'Width', unit: 'mm', min: 1, step: 1, default: 30, visibleWhen: isLogo, help: 'How wide the logo is on the part. The height follows the shape of the artwork.' },
        { type: 'bool', key: 'invert', label: 'Light parts are the shape', default: false, visibleWhen: (v) => isLogo(v) && /\.(png|jpe?g|webp|gif)$/i.test(String(v.logoName)), help: 'For pictures: use the light parts as the shape instead of the dark parts, for white art on a dark background.' },
        { type: 'number', key: 'threshold', label: 'Threshold', min: 0.05, max: 0.95, step: 0.05, default: 0.5, visibleWhen: (v) => isLogo(v) && /\.(png|jpe?g|webp|gif)$/i.test(String(v.logoName)), help: 'For pictures: how dark a spot has to be to count as part of the shape (0 to 1). Raise it to include grey areas.' },
      ],
    },
    {
      type: 'group', id: 'depth', label: 'Height', help: 'How far the artwork stands out of, or cuts into, the surface.', children: [
        { type: 'number', key: 'depth', label: 'Depth', unit: 'mm', min: 0.05, step: 0.1, default: 1, help: 'How far the artwork is raised above the surface, or cut below it. One or two layers (0.2 to 0.4 mm) is the finest that prints well.' },
        { type: 'number', key: 'weight', label: 'Boldness', unit: 'mm', step: 0.05, default: 0, help: 'Makes every stroke wider (positive) or thinner (negative) by this much on each side. Use it to thicken a thin font so it prints.' },
      ],
    },
    {
      type: 'group', id: 'placement', label: 'Placement', help: 'Where the artwork sits on the surface. You can also drag it in the viewport.', children: [
        { type: 'vector3', key: 'pos', label: 'Position', unit: 'mm', step: 1, default: [0, 0, 0], help: 'The centre of the artwork, as X, Y, Z. It snaps to the nearest point of the selected faces. Drag the yellow frame in the viewport to move it.' },
        { type: 'number', key: 'rotation', label: 'Rotation', unit: 'deg', step: 5, default: 0, help: 'Turns the artwork about the surface. 0 puts the top of the letters toward the top of the model. Drag the round handle in the viewport to turn it.' },
        { type: 'enum', key: 'wrap', label: 'Curved faces', display: 'segmented', default: 'project', options: [{ value: 'project', label: 'Project' }, { value: 'cylinder', label: 'Wrap round' }], help: 'Project drops the artwork straight onto the surface, like a stencil. Wrap round bends it around a cylinder without stretching it, so it reads the same all the way around.' },
        { type: 'bool', key: 'placed', label: 'Placed by hand', default: false, visibleWhen: () => false, help: 'Remembers that the position was chosen by hand and should not follow the selection.' },
      ],
    },
    {
      type: 'group', id: 'advanced', label: 'Advanced', collapsed: true, help: 'Less common settings.', children: [
        { type: 'number', key: 'sink', label: 'Bury depth', unit: 'mm', min: 0.05, step: 0.05, default: 0.3, visibleWhen: (v) => v.mode === 'emboss', help: 'How far the raised artwork reaches into the body so it fuses with it.' },
        { type: 'number', key: 'detail', label: 'Curve detail', unit: 'mm', min: 0.1, step: 0.05, default: 0.35, help: 'Size of the triangles used where the surface is curved. Smaller follows the curve more closely but is slower.' },
      ],
    },
  ],
}

/** Everything the worker needs, from the dialog's values. */
export async function embossArgs(v: EmbossValues, bodies: Body[], blob: (id: string) => Uint8Array | undefined, preview: boolean): Promise<{ args: EmbossOpArgs; body: Body; centre: V3 }> {
  const { rs, positions, indices } = surfaceOf(v.region, bodies, 'text or logo')
  let art: EmbossSource
  if (v.source === 'text') {
    if (!v.text.trim()) throw new Error('Type the text to emboss')
    art = { source: 'text', text: v.text, font: await loadFontBytes(v.font), size: v.textSize, letterSpacing: v.letterSpacing, lineSpacing: v.lineSpacing, align: v.align }
  } else {
    const bytes = v.logo ? blob(v.logo) : undefined
    if (!bytes) throw new Error('Choose an SVG or picture file for the logo')
    if (isSvg(v.logoName, bytes)) art = { source: 'svg', svg: new TextDecoder().decode(bytes), width: v.logoWidth }
    else {
      const r = await decodeImage(v.logo, bytes)
      art = { source: 'image', rgba: r.rgba, w: r.w, h: r.h, width: v.logoWidth, threshold: v.threshold, invert: v.invert }
    }
  }
  const args: EmbossOpArgs = {
    art, mode: v.mode, depth: v.depth, sink: v.sink, pos: v.pos, rotation: v.rotation, wrap: v.wrap, weight: v.weight, detail: v.detail, positions, indices, preview,
  }
  return { args, body: rs.body, centre: centroidOf(positions, indices) }
}

registerFeature({
  type: 'emboss',
  label: 'Text and logos',
  icon: TextAa,
  schema: embossSchema,
  async compute(ctx, raw) {
    const v = raw as unknown as EmbossValues
    const { args, body } = await embossArgs(v, ctx.bodies, ctx.blob, false)
    const r = (await ctx.kernel.call('embossFace', { ...args, targetKey: body.key, id: body.id, name: body.name })) as { bodies: Body[]; warnings: string[] }
    return { bodies: r.bodies, warning: r.warnings.length ? r.warnings.join('. ') : undefined }
  },
  preview: (ctx) => embossPreview(ctx),
})

const same = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-3

function embossPreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur: ParamValues = values
  let autoPos: V3 | null = null
  const geometry = () => useDoc.getState().geometry
  const put = (patch: ParamValues) => { cur = { ...cur, ...patch }; setValues(cur) }
  const faces = bindRegion((region) => put({ region }), (cur.region as string[]).length ? 'off' : 'click')
  faces.show(cur.region as string[])

  const runner = createRunner(async (stale) => {
    try {
      const v = resolveParams(embossSchema, cur) as unknown as EmbossValues
      if (!v.region.length) { useDetailView.setState({ emboss: null, readout: null, busy: false }); useUi.setState({ inspectorNotice: null }); return }
      useDetailView.setState({ busy: true })
      const blobs = useDoc.getState().blobs
      const { args, centre } = await embossArgs(v, geometry(), (id) => blobs[id], true)
      // until the artwork is moved by hand it stays in the middle of the selected faces
      if (!v.placed && !same(v.pos, centre)) { autoPos = centre; put({ pos: centre }); return }
      const res = (await getKernel().call('embossFace', args)) as EmbossPreview
      if (stale()) return
      const notes = res.warnings.length ? ' | ' + res.warnings.join('. ') : ''
      useDetailView.setState({
        emboss: {
          mesh: res.mesh, mode: v.mode, point: res.point, normal: res.normal, width: res.width, height: res.height, rotation: v.rotation,
          moveTo: (p) => put({ pos: p, placed: true }),
          rotateTo: (deg) => put({ rotation: deg }),
        },
        readout: `${res.width.toFixed(1)} x ${res.height.toFixed(1)} mm${res.wrapped === 'cylinder' ? ', wrapped around the cylinder' : ''}${notes}`,
        busy: false,
      })
      useUi.setState({ inspectorNotice: null })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!stale()) { useDetailView.setState({ emboss: null, readout: null, busy: false }); useUi.setState({ inspectorNotice: msg }) }
    }
  }, 220)
  runner.schedule()
  return {
    update(v) {
      // a position typed by hand (or dragged) is kept; one that just follows the selection is not
      if (!v.placed && autoPos && !same(v.pos as V3, autoPos) && !same(v.pos as V3, [0, 0, 0])) { v = { ...v, placed: true }; setTimeout(() => setValues(v), 0) }
      cur = v
      faces.sync(v.region as string[])
      runner.schedule()
    },
    dispose() {
      runner.dispose()
      faces.dispose()
      clearDetailView()
      useUi.setState({ inspectorNotice: null })
    },
  }
}

/** Ribbon entry points. */
export function startEmboss(source: 'text' | 'logo') {
  const region = regionFromSelection(useUi.getState().selection, useDoc.getState().geometry)
  createFeature('emboss', { region, source }, source === 'text' ? 'detail.text' : 'detail.logo')
}
