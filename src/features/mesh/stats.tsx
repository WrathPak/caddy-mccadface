/** Mesh stats: a glass card over the viewport with the health of the selected mesh body (triangles, open edges, manifold, volume, area, shells). */
import { useEffect } from 'react'
import { create } from 'zustand'
import { CheckCircle, Warning, X } from '@phosphor-icons/react'
import { useDoc } from '@/doc/store'
import { getKernel } from '@/kernel/client'
import type { MeshStats } from '@/kernel/meshedit'
import { useUi } from '@/store/ui'
import './mesh.css'

type Entry = MeshStats | 'busy' | 'failed'
interface State { pinned: boolean; stats: Record<string, Entry> }
export const useMeshStats = create<State>(() => ({ pinned: false, stats: {} }))
export const toggleMeshStats = () => useMeshStats.setState((s) => ({ pinned: !s.pinned }))

const inflight = new Set<string>()
function load(key: string) {
  if (inflight.has(key) || useMeshStats.getState().stats[key]) return
  inflight.add(key)
  useMeshStats.setState((s) => ({ stats: { ...s.stats, [key]: 'busy' } }))
  getKernel().call('meshStats', { key }).then((r) => useMeshStats.setState((s) => ({ stats: { ...s.stats, [key]: r as MeshStats } })))
    .catch(() => useMeshStats.setState((s) => ({ stats: { ...s.stats, [key]: 'failed' } })))
    .finally(() => inflight.delete(key))
}

const num = (n: number) => n.toLocaleString('en-US')
const dec = (n: number, d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d })

export function MeshStatsCard() {
  const selection = useUi((s) => s.selection)
  const hidden = useUi((s) => s.hiddenIds)
  const geometry = useDoc((s) => s.geometry)
  const pinned = useMeshStats((s) => s.pinned)
  const stats = useMeshStats((s) => s.stats)
  const picked = [...new Set(selection.map((r) => r.id))].map((id) => geometry.find((b) => b.id === id)).filter((b) => b && b.kind === 'mesh')
  // pinned from the ribbon: the picked bodies, else every mesh body
  const bodies = (picked.length ? picked : pinned ? geometry.filter((b) => b.kind === 'mesh' && !hidden[b.id]) : []) as typeof geometry
  const keys = bodies.map((b) => b.key).join('|')
  useEffect(() => { for (const b of bodies) load(b.key) }, [keys]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!bodies.length) return null
  const shown = bodies.slice(0, 3)
  return (
    <div className="mesh-card glass" role="region" aria-label="Mesh stats">
      <div className="mc-head">
        <span>Mesh stats</span>
        {pinned && <button type="button" className="mc-x" aria-label="Close mesh stats" onClick={() => useMeshStats.setState({ pinned: false })}><X size={12} weight="bold" /></button>}
      </div>
      {shown.map((b) => {
        const s = stats[b.key]
        const st = typeof s === 'object' ? s : null
        return (
          <div className="mc-body" key={b.id}>
            <div className="mc-name">
              <span title={b.name}>{b.name}</span>
              {st && (st.manifold
                ? <em className="ok"><CheckCircle size={13} weight="fill" /> Manifold, watertight</em>
                : <em className="bad"><Warning size={13} weight="fill" /> Not manifold</em>)}
            </div>
            {st ? (
              <dl>
                <dt>Triangles</dt><dd>{num(st.triangles)}</dd>
                <dt>Open edges</dt><dd className={st.openEdges ? 'bad' : ''}>{num(st.openEdges)}</dd>
                <dt>Non-manifold edges</dt><dd className={st.nonManifoldEdges ? 'bad' : ''}>{num(st.nonManifoldEdges)}</dd>
                <dt>Flipped edges</dt><dd className={st.flippedEdges ? 'bad' : ''}>{num(st.flippedEdges)}</dd>
                <dt>Shells</dt><dd>{num(st.shells)}</dd>
                <dt>Volume</dt><dd>{dec(st.volume)} mm³</dd>
                <dt>Surface area</dt><dd>{dec(st.area)} mm²</dd>
              </dl>
            ) : <div className="mc-wait">{s === 'failed' ? 'Could not measure this mesh' : 'Measuring...'}</div>}
          </div>
        )
      })}
      {bodies.length > shown.length && <div className="mc-wait">and {bodies.length - shown.length} more</div>}
    </div>
  )
}
