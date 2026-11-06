import { useLayoutEffect, type RefObject } from 'react'

/**
 * A segmented control's raised thumb slides under the chosen option: this measures the chosen button (the first match of `chosen`) and
 * publishes its place as --thumb-x / --thumb-w on the container, which the stylesheet turns into a transform with an ease.
 */
export function useThumb(ref: RefObject<HTMLElement | null>, chosen: string, key: unknown) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const on = el.querySelector<HTMLElement>(chosen)
      if (!on) return void el.style.setProperty('--thumb-o', '0')
      el.style.setProperty('--thumb-x', on.offsetLeft + 'px')
      el.style.setProperty('--thumb-w', on.offsetWidth + 'px')
      el.style.setProperty('--thumb-o', '1')
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, chosen, key])
}
