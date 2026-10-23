import { defineConfig, type Plugin } from 'vitest/config'
import path from 'node:path'

/** `foo.wasm?url` normally resolves to a served URL; in Node tests we want the absolute file path instead. */
function nodeWasmUrl(): Plugin {
  const PREFIX = 'virtual:nodeurl:'
  return {
    name: 'node-wasm-url',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith('?url')) return null
      const r = await this.resolve(source.slice(0, -4), importer, { skipSelf: true })
      return r ? PREFIX + r.id.split('?')[0] : null
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null
      return `export default ${JSON.stringify(path.normalize(id.slice(PREFIX.length)))}`
    },
  }
}

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  plugins: [nodeWasmUrl()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
})
