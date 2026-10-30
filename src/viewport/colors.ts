import { useMemo } from 'react'
import { useUi } from '@/store/ui'
import { useSettings } from '@/settings/settings'
import { Color } from 'three'

const read = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888888'

/** Viewport colors from the CSS tokens; recomputed when the theme changes. */
export function useVpColors() {
  const theme = useUi((s) => s.theme)
  const custom = useSettings((s) => s.selectionColor)
  return useMemo(
    () => ({
      bg: read('--vp-bg'),
      grid: read('--vp-grid'),
      gridMajor: read('--vp-grid-major'),
      axisX: read('--vp-axis-x'),
      axisY: read('--vp-axis-y'),
      axisZ: read('--vp-axis-z'),
      body: read('--vp-body'),
      surface: read('--vp-surface'),
      edge: read('--vp-edge'),
      accent: read('--accent'),
      /** whether the user picked a selection colour (else everything keeps its own default) */
      custom: custom !== '',
      /** selected and pre-selected (hovered) things: the chosen colour, else the accent */
      sel: custom || read('--accent'),
      /** the hover colour that goes with it: the same hue, lighter */
      hover: custom ? '#' + new Color(custom).lerp(new Color('#ffffff'), 0.35).getHexString() : (read('--accent-hover') === '#888888' ? '#78c4d3' : read('--accent-hover')),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme, custom],
  )
}
