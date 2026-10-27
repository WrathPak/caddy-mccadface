import { useMemo } from 'react'
import { useUi } from '@/store/ui'

const read = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888888'

/** Viewport colors from the CSS tokens; recomputed when the theme changes. */
export function useVpColors() {
  const theme = useUi((s) => s.theme)
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
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme],
  )
}
