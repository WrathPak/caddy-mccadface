// @ts-check

// the maths of an involute spur gear: nothing here knows about caddy, it just turns numbers into a polygon

/**
 * point of the involute of a base circle `rb`, at roll angle `t` (radians)
 * @param {number} rb
 * @param {number} t
 * @returns {[number, number]}
 */
const involute = (rb, t) => [rb * (Math.cos(t) + t * Math.sin(t)), rb * (Math.sin(t) - t * Math.cos(t))]

/**
 * @typedef {{ teeth: number; module: number; pressureAngle: number }} GearSpec
 *   module is the tooth size in mm (pitch diameter = module * teeth), the pressure angle is in degrees
 */

/**
 * the radii that describe a gear: handy for a message or a test
 * @param {GearSpec} g
 */
export function gearRadii({ teeth, module, pressureAngle }) {
  const rp = (module * teeth) / 2
  return { pitch: rp, tip: rp + module, root: rp - 1.25 * module, base: rp * Math.cos((pressureAngle * Math.PI) / 180) }
}

/**
 * Outline of a spur gear as a list of [x, y] points, going counter-clockwise, centred on the origin.
 * @param {GearSpec & { flankPoints?: number }} g
 * @returns {[number, number][]}
 */
export function gearOutline({ teeth, module, pressureAngle, flankPoints = 8 }) {
  const { pitch: rp, tip: ra, root: rf, base: rb } = gearRadii({ teeth, module, pressureAngle })
  const rStart = Math.max(rb, rf) // below the base circle there is no involute: the flank goes straight down
  /** roll angle where the involute reaches radius r */
  const roll = (/** @type {number} */ r) => Math.sqrt(Math.max(0, (r / rb) ** 2 - 1))
  /** angle of the involute point at roll angle t */
  const polar = (/** @type {number} */ t) => t - Math.atan(t)
  const tp = roll(rp)
  const half = Math.PI / (2 * teeth) // half a tooth thickness at the pitch circle, as an angle
  const t0 = roll(rStart)
  const t1 = roll(ra)

  // the right flank (the clockwise side of a tooth centred on angle 0), root to tip, as [angle, radius]
  /** @type {[number, number][]} */
  const right = []
  for (let i = 0; i <= flankPoints; i++) {
    const t = t0 + ((t1 - t0) * i) / flankPoints
    const [x, y] = involute(rb, t)
    right.push([polar(t) - polar(tp) - half, Math.hypot(x, y)]) // the angle that puts this point where the tooth wants it
  }
  const left = right.map(([a, r]) => /** @type {[number, number]} */ ([-a, r])).reverse() // mirrored, tip to root

  /** @type {[number, number][]} */
  const out = []
  for (let k = 0; k < teeth; k++) {
    const turn = (2 * Math.PI * k) / teeth
    const place = (/** @type {[number, number]} */ [a, r]) => out.push([r * Math.cos(a + turn), r * Math.sin(a + turn)])
    if (rf < rStart) place([right[0][0], rf]) // straight down to the root circle
    right.forEach(place)
    left.forEach(place)
    if (rf < rStart) place([left[left.length - 1][0], rf])
  }
  return out
}

/**
 * a circle as a polygon, for the bore
 * @param {number} radius
 * @param {number} [segments]
 * @returns {[number, number][]}
 */
export function circleOutline(radius, segments = 48) {
  return Array.from({ length: segments }, (_, i) => /** @type {[number, number]} */ ([radius * Math.cos((2 * Math.PI * i) / segments), radius * Math.sin((2 * Math.PI * i) / segments)]))
}
