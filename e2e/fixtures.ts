import fs from 'node:fs'
import path from 'node:path'

/** Binary STL of a closed cylinder along +Z (base on z = 0, centred on the Z axis). */
export function cylinderStl(radius: number, height: number, segments = 48): Buffer {
  const tris: number[][][] = []
  const ring = (i: number, z: number) => [radius * Math.cos((2 * Math.PI * i) / segments), radius * Math.sin((2 * Math.PI * i) / segments), z]
  for (let i = 0; i < segments; i++) {
    const a0 = ring(i, 0), a1 = ring(i + 1, 0), b0 = ring(i, height), b1 = ring(i + 1, height)
    tris.push([a0, a1, b1], [a0, b1, b0]) // side (outward, counter-clockwise seen from outside)
    tris.push([[0, 0, 0], a1, a0]) // bottom, normal -Z
    tris.push([[0, 0, height], b0, b1]) // top, normal +Z
  }
  const buf = Buffer.alloc(84 + tris.length * 50)
  buf.write('caddy e2e cylinder', 0)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, k) => {
    const o = 84 + k * 50
    const u = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]]
    const v = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]]
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const l = Math.hypot(...n) || 1
    ;[n[0] / l, n[1] / l, n[2] / l].forEach((x, i) => buf.writeFloatLE(x, o + i * 4))
    t.forEach((p, j) => p.forEach((x, i) => buf.writeFloatLE(x, o + 12 + j * 12 + i * 4)))
  })
  return buf
}

export function writeCylinderFixture(): string {
  const dir = path.resolve(import.meta.dirname, 'fixtures')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'cylinder.stl')
  fs.writeFileSync(file, cylinderStl(8, 30))
  return file
}
