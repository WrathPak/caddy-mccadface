import { describe, expect, it } from 'vitest'
import { filesFromInput, packageFromFile, packageFromFolder, parseManifest, slug } from './package'
import { membersOf } from './completions'

const f = (text: string, name: string) => new File([text], name)

describe('reading a plugin from what was picked', () => {
  it('a single .js file is a plugin named after the file', async () => {
    const p = await packageFromFile(f('export function activate() {}', 'My Cool Plugin.js'))
    expect(p).toMatchObject({ id: 'my-cool-plugin', name: 'My Cool Plugin', entry: 'My Cool Plugin.js', permissions: [] })
    expect(Object.keys(p.files)).toEqual(['My Cool Plugin.js'])
    await expect(packageFromFile(f('x', 'notes.txt'))).rejects.toThrow(/\.js file/)
  })

  it('a folder uses plugin.json for the name, entry and permissions', async () => {
    const files = new Map([
      ['plugin.json', f(JSON.stringify({ id: 'gears', name: 'Gears', version: '2.0.0', main: 'src/main.js', permissions: ['download'] }), 'plugin.json')],
      ['src/main.js', f("import './util.js'", 'main.js')],
      ['src/util.js', f('export {}', 'util.js')],
      ['README.md', f('hi', 'README.md')],
      ['node_modules/x/index.js', f('no', 'index.js')],
      ['.hidden/a.js', f('no', 'a.js')],
    ])
    const p = await packageFromFolder('gears-folder', files)
    expect(p).toMatchObject({ id: 'gears', name: 'Gears', version: '2.0.0', entry: 'src/main.js', permissions: ['download'] })
    expect(Object.keys(p.files).sort()).toEqual(['src/main.js', 'src/util.js'])
  })

  it('a folder without plugin.json needs an index.js and is named after the folder', async () => {
    const p = await packageFromFolder('My Folder', new Map([['index.js', f('export {}', 'index.js')]]))
    expect(p).toMatchObject({ id: 'my-folder', name: 'My Folder', entry: 'index.js' })
    await expect(packageFromFolder('x', new Map([['other.js', f('export {}', 'other.js')]]))).rejects.toThrow(/no index\.js/)
    await expect(packageFromFolder('x', new Map([['plugin.json', f('{"main":"gone.js"}', 'plugin.json')], ['index.js', f('', 'index.js')]]))).rejects.toThrow(/no gone\.js/)
  })

  it('refuses a plugin.json that is wrong, naming the problem', () => {
    expect(() => parseManifest('{nope')).toThrow(/not valid JSON/)
    expect(() => parseManifest('[]')).toThrow(/must be an object/)
    expect(() => parseManifest('{"id":"Bad Id"}')).toThrow(/lower case/)
    expect(() => parseManifest('{"permissions":["root"]}')).toThrow(/unknown permission "root"/)
    expect(parseManifest('{}')).toEqual({ id: undefined, name: undefined, version: undefined, description: undefined, main: undefined, permissions: [] })
  })

  it('reads the files of a webkitdirectory pick', () => {
    const a = Object.assign(f('', 'index.js'), { webkitRelativePath: 'my-plugin/index.js' })
    const b = Object.assign(f('', 'lib.js'), { webkitRelativePath: 'my-plugin/lib/lib.js' })
    const r = filesFromInput([a, b])
    expect(r.name).toBe('my-plugin')
    expect([...r.files.keys()]).toEqual(['index.js', 'lib/lib.js'])
  })

  it('makes ids from names', () => {
    expect(slug('Gear Maker v2.js')).toBe('gear-maker-v2')
    expect(slug('!!!')).toBe('plugin')
  })
})

describe('completion for caddy.', () => {
  it('offers the namespaces and the members below them', () => {
    expect(membersOf('caddy').map((c) => c.label)).toEqual(expect.arrayContaining(['kernel', 'document', 'selection', 'commands', 'features', 'ribbon', 'io', 'ui', 'log', 'version']))
    const k = membersOf('caddy.kernel').map((c) => c.label)
    expect(k).toEqual(expect.arrayContaining(['box', 'cylinder', 'extrude', 'boolean', 'mesh']))
    expect(membersOf('caddy.kernel.mesh').map((c) => c.label).sort()).toEqual(['boolean', 'booleanMany', 'fromTriangles'])
    expect(membersOf('caddy.nothing')).toEqual([])
    expect(membersOf('caddy.kernel').find((c) => c.label === 'box')).toMatchObject({ type: 'method' })
  })
})
