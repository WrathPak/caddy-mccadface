// Links a plugin made of several files into modules the sandbox can import. Every file becomes its own blob URL, in dependency
// order, with its relative imports rewritten to those URLs. Pure (no DOM), so it runs in the sandbox and in Node tests.
// Only relative imports of the plugin's own files are allowed: no bare packages, no URLs.

const STATIC = /\b(import|export)\s+(?:[\w*${}\s,]+?\s+from\s+)?(['"])([^'"\n]+)\2/g
const DYNAMIC = /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g

export function normalizePath(p) {
  const out = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { if (!out.length) throw new Error('"' + p + '" climbs out of the plugin folder'); out.pop() } else out.push(part)
  }
  return out.join('/')
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** The file a specifier refers to, tried as written, with .js, and as a folder's index.js. */
export function resolveSpecifier(from, spec, files) {
  if (!(spec.startsWith('./') || spec.startsWith('../'))) {
    throw new Error('"' + spec + '" in ' + from + ': plugins can only import their own files with a relative path (./file.js)')
  }
  const base = normalizePath(dirOf(from) + '/' + spec)
  for (const cand of [base, base + '.js', base + '.mjs', base + '/index.js']) if (Object.prototype.hasOwnProperty.call(files, cand)) return cand
  throw new Error(from + ' imports "' + spec + '", but there is no such file in the plugin')
}

/** The source with comments overwritten by spaces (same length), so an `import` in a comment is not taken for a dependency. */
export function blankComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ')
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[\s;{}()])\/\/[^\n]*/g, (m, lead) => lead + blank(m.slice(lead.length)))
}

/** Specifiers of a module's source (static imports, re-exports and import("...") with a plain string) and where they sit. */
export function specifiersOf(source) {
  const found = []
  const text = blankComments(source)
  for (const m of text.matchAll(STATIC)) found.push({ spec: m[3], at: m.index + m[0].lastIndexOf(m[3]), len: m[3].length })
  for (const m of text.matchAll(DYNAMIC)) found.push({ spec: m[2], at: m.index + m[0].indexOf(m[2]), len: m[2].length })
  return found.sort((a, b) => a.at - b.at)
}

/**
 * Turn `files` (path -> source) into blob URLs. `makeUrl(source)` creates one URL. Returns the URL of `entry`.
 * Throws on a missing file, a bare package import or an import cycle.
 */
export function linkModules(files, entry, makeUrl) {
  const norm = {}
  for (const k of Object.keys(files)) norm[normalizePath(k)] = files[k]
  const start = normalizePath(entry)
  if (!Object.prototype.hasOwnProperty.call(norm, start)) throw new Error('The plugin has no ' + entry)
  const urls = {}
  const visiting = []
  function build(path) {
    if (urls[path]) return urls[path]
    if (visiting.includes(path)) throw new Error('Import cycle: ' + visiting.concat(path).join(' -> '))
    visiting.push(path)
    const src = norm[path]
    let out = ''
    let last = 0
    for (const s of specifiersOf(src)) {
      const target = resolveSpecifier(path, s.spec, norm)
      out += src.slice(last, s.at) + build(target)
      last = s.at + s.len
    }
    out += src.slice(last)
    visiting.pop()
    urls[path] = makeUrl(out)
    return urls[path]
  }
  return build(start)
}
