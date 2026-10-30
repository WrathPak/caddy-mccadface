/** Threads: modeled ISO metric (or custom profile) threads on cylindrical faces, outside and inside, with a printing clearance. */
import { Nut } from '@phosphor-icons/react'
import { createFeature } from '@/doc/editor'
import { resolveParams } from '@/doc/params'
import { RefError, RefReport, decodeRef, encodeSelection, resolveFace } from '@/doc/refs'
import { registerFeature } from '@/doc/registry'
import { useDoc } from '@/doc/store'
import type { FeatureCtx, PreviewCtx, PreviewHandle } from '@/doc/types'
import { getKernel, type KernelClient } from '@/kernel/client'
import type { CylinderOfFace, ThreadOpArgs } from '@/kernel/detail-ops'
import type { Body, TopoMesh, Vec3 } from '@/kernel/types'
import { ISO_SIZES, isoProfile, nearestIso, type ThreadProfile } from '@/kernel/threads'
import { useUi } from '@/store/ui'
import type { ParamSchema, ParamValues } from '@/ui/schema'
import { clearPreview, resetManip, setPreview } from '@/viewport/preview'
import { createRunner } from '../previewKit'
import { showArrows } from '../handleKit'
import { withProgress } from './progress'
import { clearDetailView, useDetailView } from './store'

export interface ThreadValues {
  face: string[]
  kind: 'auto' | 'external' | 'internal'
  standard: 'iso' | 'custom'
  size: string
  pitchKind: 'coarse' | 'fine'
  pitch: number
  angle: number
  depth: number
  crest: number
  clearance: number
  fit: 'self' | 'bolt' | 'nut' | 'split'
  length: number
  fromEnd: 'start' | 'end'
  leftHand: boolean
}

/** Default total gap between a bolt thread and a nut thread: tuned for FDM printers (0.2 mm works on most machines at 0.2 mm layers). */
export const DEFAULT_CLEARANCE = 0.2

const iso = (v: ParamValues) => v.standard === 'iso'

export const threadSchema: ParamSchema = {
  id: 'thread',
  title: 'Thread',
  warnings: (v) => threadWarnings(v as unknown as ThreadValues),
  params: [
    { type: 'selection-ref', key: 'face', label: 'Round face', accepts: ['face'], required: true, pick: true, default: [], help: 'The round face to thread: the outside of a shaft or the inside of a hole. Its diameter becomes the major (nominal) diameter of the thread.' },
    {
      type: 'group', id: 'type', label: 'Thread', help: 'The kind and size of thread.', children: [
        { type: 'enum', key: 'kind', label: 'Type', display: 'segmented', default: 'auto', options: [{ value: 'auto', label: 'Automatic' }, { value: 'external', label: 'Outside' }, { value: 'internal', label: 'Inside' }], help: 'Automatic gives a shaft an outside (bolt) thread and a hole an inside (nut) thread. Choose one only to be sure it matches the face.' },
        { type: 'enum', key: 'standard', label: 'Profile', display: 'segmented', default: 'iso', options: [{ value: 'iso', label: 'ISO metric' }, { value: 'custom', label: 'Custom' }], help: 'ISO metric is the standard 60 degree thread of M-sized screws. Custom lets you set the pitch and the shape of the tooth, for example for a coarse printed screw.' },
        { type: 'enum', key: 'size', label: 'Size', display: 'select', default: 'auto', visibleWhen: iso, options: [{ value: 'auto', label: 'Nearest to the face' }, ...ISO_SIZES.map((s) => ({ value: String(s.d), label: `M${s.d}` }))], help: 'The metric size. Nearest to the face picks the standard size closest to the diameter of the face you chose.' },
        { type: 'enum', key: 'pitchKind', label: 'Pitch', display: 'segmented', default: 'coarse', visibleWhen: iso, options: [{ value: 'coarse', label: 'Coarse' }, { value: 'fine', label: 'Fine' }], help: 'Coarse is the normal pitch for the size. Fine has more turns per mm and a shallower tooth.' },
        { type: 'info', key: 'summary', label: 'Result', default: '', visibleWhen: iso, text: (v) => isoSummary(v as unknown as ThreadValues), help: 'The pitch and depth that will be used.' },
        { type: 'number', key: 'pitch', label: 'Pitch', unit: 'mm', min: 0.2, step: 0.25, default: 2, visibleWhen: (v) => !iso(v), help: 'Distance the thread advances in one full turn.' },
        { type: 'number', key: 'angle', label: 'Flank angle', unit: 'deg', min: 10, max: 110, step: 5, default: 60, visibleWhen: (v) => !iso(v), help: 'Angle between the two sides of the tooth. 60 is the metric standard; smaller is steeper and stronger in tension.' },
        { type: 'number', key: 'depth', label: 'Tooth depth', unit: 'mm', min: 0.1, step: 0.1, default: 1.1, visibleWhen: (v) => !iso(v), help: 'How far the tooth stands out from the root of the thread.' },
        { type: 'number', key: 'crest', label: 'Crest flat', unit: 'mm', min: 0, step: 0.1, default: 0.25, visibleWhen: (v) => !iso(v), help: 'Width of the flat on top of the tooth. A small flat is stronger and prints better than a sharp point.' },
      ],
    },
    {
      type: 'group', id: 'fit', label: 'Fit and extent', help: 'How loose the thread is and how far it runs.', children: [
        { type: 'number', key: 'clearance', label: 'Printing clearance', unit: 'mm', min: 0, step: 0.05, default: DEFAULT_CLEARANCE, help: 'How much looser the thread is made so a printed bolt and nut turn freely. 0.2 mm suits most FDM printers; use less for resin.' },
        { type: 'enum', key: 'fit', label: 'Clearance goes to', display: 'select', default: 'self', options: [{ value: 'self', label: 'This part (full)' }, { value: 'bolt', label: 'The bolt only' }, { value: 'nut', label: 'The nut only' }, { value: 'split', label: 'Half on each part' }], help: 'This part gives the part you are threading the whole clearance, so a lone bolt or nut is loose on its own. Use the bolt only or the nut only when you want the other part to stay exact, or half on each part when you make both with the same setting.' },
        { type: 'number', key: 'length', label: 'Length', unit: 'mm', min: 0, step: 1, default: 0, help: 'How far the thread runs along the face. 0 threads the whole face.' },
        { type: 'enum', key: 'fromEnd', label: 'Start at', display: 'segmented', default: 'start', visibleWhen: (v) => (v.length as number) > 0, options: [{ value: 'start', label: 'First end' }, { value: 'end', label: 'Other end' }], help: 'Which end of the face a shorter thread starts from.' },
        { type: 'bool', key: 'leftHand', label: 'Left hand thread', default: false, help: 'Turns the thread the other way (counter-clockwise to tighten). Rare; leave off for normal screws.' },
      ],
    },
  ],
}

export function isoSummary(v: ThreadValues): string {
  if (v.size === 'auto') return 'Picked from the diameter of the face'
  const s = ISO_SIZES.find((x) => String(x.d) === v.size)
  if (!s) return ''
  const p = isoProfile(v.pitchKind === 'fine' ? s.fine : s.coarse)
  return `M${s.d} x ${p.pitch}, tooth ${p.depth.toFixed(2)} mm deep`
}

export function threadWarnings(v: ThreadValues): string[] {
  const out: string[] = []
  if (v.clearance === 0) out.push('With no clearance a printed bolt and nut will bind. Use about 0.2 mm for FDM.')
  else if (v.clearance < 0.1) out.push('Under 0.1 mm of clearance may be too tight for a printed pair on an FDM printer.')
  return out
}

/** The tooth profile for a dialog: the ISO profile of a size (picked from the face when "nearest"), or the custom one. */
export function profileFor(v: ThreadValues, diameter: number): { profile: ThreadProfile; note?: string; name: string } {
  if (v.standard === 'custom') return { profile: { pitch: v.pitch, angle: v.angle, depth: v.depth, crest: v.crest }, name: `pitch ${v.pitch} mm` }
  const near = nearestIso(diameter)
  const size = v.size === 'auto' ? near.size : (ISO_SIZES.find((s) => String(s.d) === v.size) ?? near.size)
  const pitch = v.pitchKind === 'fine' ? size.fine : size.coarse
  const off = Math.abs(size.d - diameter)
  const note = off > 0.3 ? `The face is ${diameter.toFixed(2)} mm across but M${size.d} is ${size.d} mm, so the thread is cut at the size of the face` : undefined
  return { profile: isoProfile(pitch), note, name: `M${size.d} x ${pitch}` }
}

function faceOf(v: ThreadValues, bodies: Body[], report = new RefReport()): { body: Body; index: number } {
  if (!v.face.length) throw new Error('Select the round face to thread')
  const ref = decodeRef(v.face[0])
  const r = ref && ref.kind === 'face' ? resolveFace(ref, bodies, report) : null
  if (!r) throw new RefError('The face to thread no longer exists (an edit upstream removed it). Pick it again.', report.lostRefs)
  if (r.body.kind !== 'brep' || r.body.surface) throw new Error('Threads need a solid body, not a mesh or an open surface')
  return { body: r.body, index: r.index }
}

async function threadArgs(v: ThreadValues, bodies: Body[], kernel: KernelClient, id: string, previewTurns: number | undefined, report?: RefReport) {
  const { body, index } = faceOf(v, bodies, report)
  const info = (await kernel.call('threadInfo', { key: body.key, face: index })) as CylinderOfFace
  const p = profileFor(v, info.radius * 2)
  const op: ThreadOpArgs = {
    id, name: body.name, key: body.key, face: index, kind: v.kind, profile: p.profile, clearance: v.clearance, fit: v.fit, length: v.length, fromEnd: v.fromEnd, leftHand: v.leftHand, previewTurns,
  }
  return { op, body, info, ...p }
}

registerFeature({
  type: 'thread',
  label: 'Thread',
  icon: Nut,
  schema: threadSchema,
  async compute(ctx: FeatureCtx, raw) {
    const report = new RefReport()
    const v = raw as unknown as ThreadValues
    const { body } = faceOf(v, ctx.bodies)
    const { op, note } = await threadArgs(v, ctx.bodies, ctx.kernel, body.id, undefined, report)
    const result = (await withProgress(ctx.feature.id, 'building thread...', () => ctx.kernel.call('threadFace', op))) as Body
    return { bodies: [result], warning: [report.warning, note].filter(Boolean).join('. ') || undefined, reboundRefs: report.flagged, upgrades: report.upgradeMap }
  },
  preview: (ctx) => threadPreview(ctx),
})

function threadPreview({ values, setValues }: PreviewCtx): PreviewHandle {
  let cur: ParamValues = values
  let hidden: string | null = null
  const hide = (id: string | null) => {
    if (id === hidden) return
    hidden = id
    if (!id) clearPreview()
  }
  const runner = createRunner(async (stale) => {
    try {
      const v = resolveParams(threadSchema, cur) as unknown as ThreadValues
      if (!v.face.length) { hide(null); resetManip(); useDetailView.setState({ texture: null, readout: null, busy: false }); useUi.setState({ inspectorNotice: null }); return }
      useDetailView.setState({ busy: true })
      const bodies = useDoc.getState().geometry
      const { body } = faceOf(v, bodies)
      const { op, info, name, note } = await threadArgs(v, bodies, getKernel(), 'preview-' + body.id, undefined)
      // the preview is the same thread as a mesh (milliseconds); the exact B-rep is built when the dialog is accepted
      const mesh = (await getKernel().call('threadPreview', op)) as TopoMesh
      if (stale()) return
      hidden = body.id
      setPreview([], [body.id])
      const span = info.v1 - info.v0
      const full = op.length > 0 ? Math.min(op.length, span) : span
      // the length arrow stands at the end the thread starts from and runs along the face (0 means all of it)
      const end = v.fromEnd === 'end'
      const dir: Vec3 = end ? [-info.dir[0], -info.dir[1], -info.dir[2]] : info.dir
      const along = end ? info.v1 : info.v0
      showArrows(
        [{ origin: [info.origin[0] + info.dir[0] * along, info.origin[1] + info.dir[1] * along, info.origin[2] + info.dir[2] * along], dir, key: 'length', min: 1, max: span }],
        { ...v, length: full } as unknown as ParamValues, (patch) => { cur = { ...cur, ...patch }; setValues(cur) },
      )
      useDetailView.setState({
        texture: { mesh, bodyId: body.id },
        readout: `${name} ${info.external ? 'outside' : 'inside'} thread, ${(full / op.profile.pitch).toFixed(1)} turns${note ? ' | ' + note : ''}`,
        busy: false,
      })
      useUi.setState({ inspectorNotice: null })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!stale()) { hide(null); resetManip(); useDetailView.setState({ texture: null, readout: null, busy: false }); useUi.setState({ inspectorNotice: msg }) }
    }
  }, 120)
  runner.schedule()
  return {
    update(v) { cur = v; runner.schedule() },
    dispose() {
      runner.dispose()
      clearPreview()
      clearDetailView()
      resetManip()
      useUi.setState({ inspectorNotice: null })
    },
  }
}
export function startThread() {
  const face = encodeSelection(useUi.getState().selection.filter((r) => r.kind === 'face').slice(0, 1), useDoc.getState().geometry)
  createFeature('thread', { face }, 'detail.thread')
}
