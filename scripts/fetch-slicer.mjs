/**
 * Downloads the pinned Muon3D slicer engine (OrcaSlicer's libslic3r as WebAssembly) and its profile set from the GitHub
 * release, checks them, and unpacks the parts the app serves into public/slicer/. Nothing is committed: run it once after
 * install (`node scripts/fetch-slicer.mjs`). Only the single-threaded `st` engine is kept; GitHub Pages cannot send the
 * headers the threaded variants need.
 *
 * Archives are unpacked in memory (no tar binary, no shell) and every path is checked before it is written.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'fflate'

const VERSION = '0.6.1'
const RELEASE = `https://github.com/Muon-3D/muon3d-slicer-engine/releases/download/v${VERSION}`
// pinned, so a changed release cannot slip in: these are the values the release notes list
const PINNED = {
  [`muon3d-slicer-engine-${VERSION}.tgz`]: '1c6b676e0405c387fb9742568f7b142b5cb2ac3942f05022ceb9769d87cac573',
  [`muon3d-slicer-profiles-${VERSION}.tgz`]: '8c349e2fd4f2318ce373e7a657de22047e303b900ed51a3a0ed3ba6fc6ee9f56',
}
const root = path.resolve(import.meta.dirname, '..')
const outEngine = path.join(root, 'public/slicer/engine')
const outProfiles = path.join(root, 'public/slicer/profiles')
const stamp = path.join(root, 'public/slicer/.version')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function download(name) {
  const res = await fetch(`${RELEASE}/${name}`)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Regular files of a (gzipped) tar as [path without the top folder, bytes]. Rejects anything that could leave the target. */
function untar(tgz) {
  const tar = gunzipSync(new Uint8Array(tgz))
  const files = []
  let at = 0
  let longName = null
  const text = (a, b) => Buffer.from(tar.subarray(at + a, at + b)).toString('utf8').replace(/\0.*$/s, '')
  while (at + 512 <= tar.length) {
    if (tar[at] === 0) break
    const size = parseInt(text(124, 136).trim() || '0', 8)
    const type = text(156, 157) || '0'
    let name = text(0, 100)
    const prefix = text(345, 500)
    if (prefix) name = `${prefix}/${name}`
    const body = tar.subarray(at + 512, at + 512 + size)
    if (type === 'L') longName = Buffer.from(body).toString('utf8').replace(/\0.*$/s, '')
    else if (type === 'x' || type === 'g') {
      // pax header: a "path=" record renames the next entry
      const m = /\d+ path=([^\n]*)\n/.exec(Buffer.from(body).toString('utf8'))
      if (m) longName = m[1]
    } else {
      if (longName) { name = longName; longName = null }
      if (type === '0' || type === '\0') {
        const parts = name.split('/').filter((p) => p && p !== '.')
        if (parts.some((p) => p === '..') || path.isAbsolute(name) || name.includes('\\')) throw new Error(`unsafe path in archive: ${name}`)
        files.push([parts.slice(1).join('/'), body])
      } else if (type !== '5') throw new Error(`unexpected entry type ${type} for ${name}`)
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

function writeTree(dir, entries) {
  fs.rmSync(dir, { recursive: true, force: true })
  for (const [rel, bytes] of entries) {
    const dest = path.join(dir, rel)
    if (path.relative(dir, dest).startsWith('..')) throw new Error(`unsafe path: ${rel}`)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, bytes)
  }
}

if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === VERSION && !process.argv.includes('--force')) {
  console.log(`slicer ${VERSION} already in public/slicer (use --force to fetch again)`)
  process.exit(0)
}

const sums = new Map(
  (await download('SHA256SUMS')).toString('utf8').split(/\r?\n/).map((l) => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(l)).filter(Boolean).map((m) => [m[2], m[1]]),
)
const archives = {}
for (const name of Object.keys(PINNED)) {
  console.log(`downloading ${name}`)
  const buf = await download(name)
  const got = sha256(buf)
  if (got !== PINNED[name]) throw new Error(`${name}: sha256 ${got} is not the pinned ${PINNED[name]}`)
  if (sums.get(name) !== got) throw new Error(`${name}: sha256 does not match the release's SHA256SUMS`)
  archives[name] = buf
}

// the runtime: host, manifest, notices and the st engine only (the threaded variants and the precompressed copies are not served)
const keep = (rel) => !/^engine-mt/.test(rel) && !/\.(br|gz)$/.test(rel)
const engine = untar(archives[`muon3d-slicer-engine-${VERSION}.tgz`]).filter(([rel]) => keep(rel))
const manifest = JSON.parse(Buffer.from(engine.find(([rel]) => rel === 'manifest.json')[1]).toString('utf8'))
for (const [rel, bytes] of engine) {
  const want = manifest.files?.[rel]?.sha256 ?? (rel === manifest.host.file ? manifest.host.sha256 : manifest.host.chunks.find((c) => c.file === rel)?.sha256)
  if (want && sha256(bytes) !== want) throw new Error(`${rel} does not match manifest.json`)
}
for (const need of [manifest.host.file, manifest.variants.st.mjs, manifest.variants.st.wasm, ...manifest.host.chunks.map((c) => c.file)]) {
  if (!engine.some(([rel]) => rel === need)) throw new Error(`runtime is missing ${need}`)
}
writeTree(outEngine, engine)

// the profile set: the index and the vendor bundles. The all-in-one file, goldens and printer pictures are not needed here.
const profiles = untar(archives[`muon3d-slicer-profiles-${VERSION}.tgz`]).filter(([rel]) => /^profiles\/[^/]+\/(index\.[0-9a-f]+\.json|SOURCE\.json|vendors\/.+)$/.test(rel) || rel === 'LICENSE')
writeTree(outProfiles, profiles.map(([rel, bytes]) => [rel.replace(/^profiles\//, ''), bytes]))

// the index is named after its hash and a static site cannot list a folder, so leave a pointer to it
const indexRel = profiles.map(([rel]) => rel).find((rel) => /^profiles\/[^/]+\/index\.[0-9a-f]+\.json$/.test(rel))
if (!indexRel) throw new Error('the profile set has no index')
fs.writeFileSync(path.join(outProfiles, 'latest.json'), `${JSON.stringify({ index: indexRel.replace(/^profiles\//, '') })}\n`)
fs.writeFileSync(stamp, `${VERSION}\n`)
const size = (entries) => entries.reduce((n, [, b]) => n + b.length, 0)
console.log(`engine: ${engine.length} files, ${(size(engine) / 1e6).toFixed(1)} MB -> public/slicer/engine`)
console.log(`profiles: ${profiles.length} files, ${(size(profiles) / 1e6).toFixed(1)} MB -> public/slicer/profiles`)
