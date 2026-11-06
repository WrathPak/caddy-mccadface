/**
 * The frosted-glass look blurs the 3D view behind every panel. A GPU does that for free; a computer that draws everything on the
 * CPU (no graphics driver, a virtual machine, some remote desktops) pays for it on every frame the view changes, and the whole app
 * stalls. So "Auto" turns the blur off there, and the panels become the same sheets without it (more opaque, so the lines of the
 * grid do not show through unblurred). Settings > Display can force it either way; so can `?glass=on` or `?glass=off` in the address.
 */
import { useSettings, type GlassMode } from '@/settings/settings'

/** Does this WebGL renderer name belong to a software rasterizer? */
export const isSoftwareRenderer = (name: string) => /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)

let soft: boolean | null = null
/** Whether WebGL is drawn on the CPU here (measured once). */
export function softwareRendering(): boolean {
  if (soft !== null) return soft
  soft = false
  try {
    const gl = document.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    if (gl && ext) soft = isSoftwareRenderer(String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)))
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch { /* no WebGL here: the viewport will say so, the panels stay as they are */ }
  return soft
}

/** The effective choice: the address wins, then the setting, then what the machine can bear. */
export function glassOn(mode: GlassMode): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('glass')
    if (q === 'on' || q === 'off') return q === 'on'
  } catch { /* no location */ }
  return mode === 'on' || (mode === 'auto' && !softwareRendering())
}

function apply() {
  document.documentElement.dataset.glass = glassOn(useSettings.getState().glass) ? 'on' : 'off'
}

let started = false
/** Mark the page (`data-glass` on <html>, which the tokens read) and keep it in step with the setting. Call once, before the first render. */
export function startGlass() {
  if (started) return
  started = true
  apply()
  useSettings.subscribe((s, p) => { if (s.glass !== p.glass) apply() })
}

/**
 * The richer picture (studio reflections, the ground shadow) costs extra shading on every frame: it is left out where the picture is drawn
 * on the CPU. `?glass=...` in the address asks for the full look anyway (screenshots from an automated browser).
 */
export function richGraphics(): boolean {
  try { if (new URLSearchParams(window.location.search).has('glass')) return true } catch { /* no location */ }
  return !softwareRendering()
}
