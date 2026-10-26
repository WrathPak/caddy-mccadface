/**
 * Streaming STL reader. Binary files are read in chunks straight into one preallocated Float32Array (no copy of the whole
 * file, no intermediate geometry), ASCII files are decoded and scanned chunk by chunk. Runs in a worker for imports.
 */

/** A source is a Blob / File (streamed from disk) or bytes already in memory. */
export type MeshSource = Blob | Uint8Array

const CHUNK = 4 << 20

async function* chunksOf(src: MeshSource, from = 0, chunk = CHUNK): AsyncGenerator<Uint8Array> {
  if (src instanceof Uint8Array) {
    for (let o = from; o < src.length; o += chunk) yield src.subarray(o, Math.min(src.length, o + chunk))
    return
  }
  const reader = (from ? src.slice(from) : src).stream().getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

const sizeOf = (s: MeshSource) => (s instanceof Uint8Array ? s.length : s.size)
async function head(s: MeshSource, n: number): Promise<Uint8Array> {
  return s instanceof Uint8Array ? s.subarray(0, n) : new Uint8Array(await s.slice(0, n).arrayBuffer())
}

/** True when `src` is a binary STL: the triangle count in the header matches the file size. */
export async function isBinaryStl(src: MeshSource): Promise<boolean> {
  const size = sizeOf(src)
  if (size < 84) return false
  const h = await head(src, 84)
  const n = new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(80, true)
  if (84 + n * 50 === size) return true
  // a binary file whose header starts with "solid" is common; only treat it as text when it really looks like text
  const start = new TextDecoder().decode(h.subarray(0, 5))
  return start !== 'solid' && (size - 84) % 50 === 0
}

/**
 * Parse an STL into a triangle soup (9 floats per triangle). `onProgress` gets 0..1.
 * Rejects when no triangles are found.
 */
export async function parseStlSoup(src: MeshSource, onProgress?: (f: number) => void, chunk = CHUNK): Promise<Float32Array> {
  const size = sizeOf(src)
  const out = (await isBinaryStl(src)) ? await parseBinary(src, size, onProgress, chunk) : await parseAscii(src, size, onProgress, chunk)
  if (!out.length) throw new Error('No triangles found in the STL file')
  return out
}

async function parseBinary(src: MeshSource, size: number, onProgress: ((f: number) => void) | undefined, chunkSize: number): Promise<Float32Array> {
  const h = await head(src, 84)
  const declared = new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(80, true)
  const n = Math.min(declared, Math.floor((size - 84) / 50))
  const out = new Float32Array(n * 9)
  const carry = new Uint8Array(50)
  const carryView = new DataView(carry.buffer)
  let carryLen = 0
  let tri = 0
  let read = 0
  const rec = (dv: DataView, o: number) => {
    if (tri >= n) return
    const b = tri * 9
    for (let k = 0; k < 9; k++) out[b + k] = dv.getFloat32(o + 12 + k * 4, true)
    tri++
  }
  for await (const raw of chunksOf(src, 84, chunkSize)) {
    const chunk = raw
    let off = 0
    if (carryLen) {
      const take = Math.min(50 - carryLen, chunk.length)
      carry.set(chunk.subarray(0, take), carryLen)
      carryLen += take
      off = take
      if (carryLen === 50) { rec(carryView, 0); carryLen = 0 }
    }
    const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const whole = Math.floor((chunk.length - off) / 50)
    for (let k = 0; k < whole; k++) rec(dv, off + k * 50)
    off += whole * 50
    if (off < chunk.length) { carry.set(chunk.subarray(off), 0); carryLen = chunk.length - off }
    read += chunk.length
    onProgress?.(Math.min(1, read / Math.max(1, size - 84)))
  }
  return tri === n ? out : out.slice(0, tri * 9)
}

async function parseAscii(src: MeshSource, size: number, onProgress: ((f: number) => void) | undefined, chunkSize: number): Promise<Float32Array> {
  let out = new Float32Array(1 << 16)
  let n = 0
  const push = (a: number, b: number, c: number) => {
    if (n + 3 > out.length) { const o = new Float32Array(out.length * 2); o.set(out); out = o }
    out[n++] = a; out[n++] = b; out[n++] = c
  }
  const dec = new TextDecoder()
  const re = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g
  let tail = ''
  let read = 0
  const scan = (text: string) => {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]))
  }
  for await (const chunk of chunksOf(src, 0, chunkSize)) {
    const text = tail + dec.decode(chunk, { stream: true })
    // a vertex is one line: scan up to the last newline and carry the unfinished line over
    const cut = text.lastIndexOf('\n') + 1
    scan(text.slice(0, cut))
    tail = text.slice(cut)
    read += chunk.length
    onProgress?.(Math.min(1, read / Math.max(1, size)))
  }
  scan(tail + dec.decode())
  if (n % 9 !== 0) throw new Error('The STL file is cut off (the vertex count is not a multiple of 3)')
  return out.slice(0, n)
}
