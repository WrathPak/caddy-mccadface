/** Feature roles of a toolpath ("Outer wall", ...): Orca's names and its preview colors. */

const ROLE_COLORS: Record<string, string> = {
  'outer wall': '#ff7d38',
  'inner wall': '#ffe64d',
  'overhang wall': '#1f1fff',
  'sparse infill': '#b03029',
  'internal solid infill': '#9654cc',
  'top surface': '#f04040',
  'bottom surface': '#7a2e8e',
  'ironing': '#ff8c69',
  'bridge': '#4d80ba',
  'internal bridge': '#4d80ba',
  'gap infill': '#ffffff',
  'skirt': '#00876e',
  'brim': '#00876e',
  'support': '#00ff00',
  'support interface': '#008000',
  'support transition': '#00b050',
  'prime tower': '#b3e3ab',
  'wipe tower': '#b3e3ab',
  'custom': '#5ed194',
  'floating vertical shell': '#cc6677',
}

export const roleKey = (name: string) => name.trim().toLowerCase()

const hashColor = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  const hue = Math.abs(h) % 360
  const c = (n: number) => {
    const k = (n + hue / 30) % 12
    const a = 0.55 * Math.min(0.58, 1 - 0.58)
    return Math.round(255 * (0.58 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return '#' + [c(0), c(8), c(4)].map((v) => v.toString(16).padStart(2, '0')).join('')
}

export const roleColor = (name: string): string => ROLE_COLORS[roleKey(name)] ?? hashColor(roleKey(name))

export const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0.8, 0.8, 0.8]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
