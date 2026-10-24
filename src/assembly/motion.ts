/** Motion study: keyframes on joint values, sampled at a time. Playback runs on the nav clock so tests can step it. */
import { navClock } from '@/viewport/navClock'
import { useAssemblyRuntime } from './runtime'
import type { DriveMap } from './solver'
import type { Keyframe, MotionStudy, MotionTrack } from './types'

/** Value of a track at time t (seconds): straight lines between keyframes, held before the first and after the last. */
export function sampleTrack(frames: Keyframe[], t: number): number {
  if (!frames.length) return 0
  const f = [...frames].sort((a, b) => a.t - b.t)
  if (t <= f[0].t) return f[0].v
  const last = f[f.length - 1]
  if (t >= last.t) return last.v
  let i = 1
  while (f[i].t < t) i++
  const a = f[i - 1], b = f[i]
  const k = (t - a.t) / Math.max(b.t - a.t, 1e-9)
  return a.v + (b.v - a.v) * k
}

/** The joint values the study gives at time t. */
export function studyDrive(study: Pick<MotionStudy, 'tracks'>, t: number): DriveMap {
  const out: DriveMap = {}
  for (const tr of study.tracks) {
    if (!tr.frames.length) continue
    ;(out[tr.joint] ??= {})[tr.key] = sampleTrack(tr.frames, t)
  }
  return out
}

/** Length of the study: the set duration, or the last keyframe when that is later. */
export const studyLength = (study: Pick<MotionStudy, 'duration' | 'tracks'>) =>
  Math.max(study.duration, ...study.tracks.flatMap((t: MotionTrack) => t.frames.map((f) => f.t)), 0)

/** Add or move the keyframe of a track at time t. */
export function withKeyframe(track: MotionTrack | undefined, joint: string, key: string, t: number, v: number): MotionTrack {
  const frames = (track?.frames ?? []).filter((f) => Math.abs(f.t - t) > 1e-6)
  frames.push({ t, v })
  return { joint, key, frames: frames.sort((a, b) => a.t - b.t) }
}

// ---------------------------------------------------------------- playback + explode animation

interface Anim {
  motion: { start: number; study: MotionStudy } | null
  explode: { from: number; to: number; start: number; ms: number } | null
}
const anim: Anim = { motion: null, explode: null }
let looping = false

const raf = (fn: () => void) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16))

/** Advance the running animations to the nav clock's time. Called every frame, and by tests after stepping the clock. */
export function tickAnimations(): boolean {
  const rt = useAssemblyRuntime.getState()
  const now = navClock.now()
  if (anim.motion) {
    const { start, study } = anim.motion
    const len = studyLength(study)
    let t = (now - start) / 1000
    if (t >= len) {
      if (study.loop && len > 0) t = t % len
      else {
        t = len
        anim.motion = null
        rt.setPlay({ playing: false, playTime: len })
        useAssemblyRuntime.setState({ drive: studyDrive(study, len) })
        return !!anim.explode
      }
    }
    rt.setPlay({ playTime: t })
    useAssemblyRuntime.setState({ drive: studyDrive(study, t) })
  }
  if (anim.explode) {
    const { from, to, start, ms } = anim.explode
    const k = Math.min(1, (now - start) / ms)
    // ease in and out
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
    rt.setExplode(from + (to - from) * e)
    if (k >= 1) anim.explode = null
  }
  return !!(anim.motion || anim.explode)
}

function ensureLoop() {
  if (looping) return
  looping = true
  const step = () => {
    if (tickAnimations()) raf(step)
    else looping = false
  }
  raf(step)
}

/** Play the study from `from` seconds. */
export function playMotion(study: MotionStudy, from = 0) {
  anim.motion = { start: navClock.now() - from * 1000, study }
  useAssemblyRuntime.getState().setPlay({ playing: true, playTime: from })
  tickAnimations()
  ensureLoop()
}
export function stopMotion(reset = false) {
  anim.motion = null
  const rt = useAssemblyRuntime.getState()
  rt.setPlay({ playing: false })
  if (reset) {
    rt.setPlay({ playTime: 0 })
    rt.clearDrive()
  }
}
/** Show the study at time t without playing. */
export function seekMotion(study: MotionStudy, t: number) {
  anim.motion = null
  const rt = useAssemblyRuntime.getState()
  rt.setPlay({ playing: false, playTime: t })
  useAssemblyRuntime.setState({ drive: studyDrive(study, t) })
}

/** Move the explode amount to 0 (collapse) or 1 (explode) over `ms`. */
export function animateExplode(to: number, ms = 900) {
  const from = useAssemblyRuntime.getState().explode
  if (Math.abs(from - to) < 1e-9) return
  anim.explode = { from, to, start: navClock.now(), ms }
  tickAnimations()
  ensureLoop()
}
export function stopAnimations() {
  anim.motion = null
  anim.explode = null
}
