/**
 * Pull `thumbnail.png` out of a `.caddy` without reading the file: only the end of the archive (the central directory) and
 * the thumbnail's own bytes are read from the Blob. A project that carries a 150 MB import still lists instantly.
 */
import { inflateSync } from 'fflate'

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)

async function bytesOf(blob: Blob, from: number, to: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(from, to).arrayBuffer())
}

/** The named entry of a zip Blob, or null when it is not there (or the archive is not a plain zip). */
export async function readZipEntry(blob: Blob, name: string): Promise<Uint8Array | null> {
  const size = blob.size
  if (size < 22) return null
  const tailLen = Math.min(size, 22 + 0xffff)
  const tail = await bytesOf(blob, size - tailLen, size)
  let e = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { e = i; break }
  }
  if (e < 0) return null
  const count = u16(tail, e + 10)
  const cdSize = u32(tail, e + 12)
  const cdOffset = u32(tail, e + 16)
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || cdOffset + cdSize > size) return null // zip64 or damaged
  const cd = await bytesOf(blob, cdOffset, cdOffset + cdSize)
  const want = new TextEncoder().encode(name)
  let p = 0
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (u32(cd, p) !== 0x02014b50) return null
    const method = u16(cd, p + 10)
    const csize = u32(cd, p + 20)
    const nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32)
    const local = u32(cd, p + 42)
    const nameBytes = cd.subarray(p + 46, p + 46 + nlen)
    p += 46 + nlen + xlen + clen
    if (nameBytes.length !== want.length || !want.every((v, k) => v === nameBytes[k])) continue
    const head = await bytesOf(blob, local, local + 30)
    if (u32(head, 0) !== 0x04034b50) return null
    const start = local + 30 + u16(head, 26) + u16(head, 28)
    const data = await bytesOf(blob, start, start + csize)
    if (method === 0) return data
    if (method === 8) return inflateSync(data)
    return null
  }
  return null
}

/** The viewport thumbnail stored in a `.caddy`, as an image Blob. */
export async function readThumbnail(file: Blob): Promise<Blob | null> {
  try {
    const png = await readZipEntry(file, 'thumbnail.png')
    return png ? new Blob([png as BlobPart], { type: 'image/png' }) : null
  } catch {
    return null
  }
}
