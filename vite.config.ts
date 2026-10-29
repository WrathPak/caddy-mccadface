import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

// BASE_PATH is set for the github pages build (/caddy-mccadface/), local dev stays at /
const base = process.env.BASE_PATH || '/'

/**
 * Publishes the plugin API types: `caddy-api.d.ts` is served at /caddy-api.d.ts by the dev server and emitted into the build,
 * so plugin authors (and the Plugins panel's download link) get the same file the app was built with.
 */
function caddyApiTypes(): Plugin {
  const file = path.resolve(import.meta.dirname, 'src/api/caddy-api.d.ts')
  return {
    name: 'caddy-api-types',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== base + 'caddy-api.d.ts') return next()
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(fs.readFileSync(file))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'caddy-api.d.ts', source: fs.readFileSync(file, 'utf8') })
    },
  }
}

export default defineConfig({
  base,
  resolve: { alias: { '@': path.resolve(import.meta.dirname, "src") } },
  plugins: [
    caddyApiTypes(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'CADdy McCADFace',
        short_name: 'CADFace',
        description: 'Local-only parametric CAD',
        theme_color: '#1b1d21',
        background_color: '#1b1d21',
        display: 'standalone',
        // phones and tablets: either way up, the app lays itself out for the shape
        orientation: 'any',
        start_url: '.',
        scope: '.',
        id: '.',
        categories: ['productivity', 'graphics'],
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 64 * 1024 * 1024,
      },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
})
