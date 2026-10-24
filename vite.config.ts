import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

// BASE_PATH is set for the github pages build (/caddy-mccadface/), local dev stays at /
const base = process.env.BASE_PATH || '/'

export default defineConfig({
  base,
  resolve: { alias: { '@': path.resolve(import.meta.dirname, "src") } },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'CADdy McCADFace',
        short_name: 'CADFace',
        description: 'Local-only parametric CAD',
        theme_color: '#1b1d21',
        background_color: '#1b1d21',
        display: 'standalone',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 64 * 1024 * 1024,
      },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
})
