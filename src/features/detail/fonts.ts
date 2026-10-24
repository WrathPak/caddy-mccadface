/** Fonts bundled with the app (open licence, self-hosted by the build: nothing is fetched from another site). */
import interRegular from '@fontsource/inter/files/inter-latin-400-normal.woff?url'
import interBold from '@fontsource/inter/files/inter-latin-700-normal.woff?url'
import jetbrainsBold from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff?url'
import robotoSlabBold from '@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff?url'
import playfairBold from '@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff?url'
import oswaldMedium from '@fontsource/oswald/files/oswald-latin-500-normal.woff?url'
import bebas from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff?url'
import orbitronBold from '@fontsource/orbitron/files/orbitron-latin-700-normal.woff?url'
import pacifico from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url'
import caveatBold from '@fontsource/caveat/files/caveat-latin-700-normal.woff?url'
import marker from '@fontsource/permanent-marker/files/permanent-marker-latin-400-normal.woff?url'

export interface FontDef { id: string; label: string; url: string; style: string }

export const FONTS: FontDef[] = [
  { id: 'inter-bold', label: 'Inter Bold', url: interBold, style: 'Clean sans serif' },
  { id: 'inter', label: 'Inter Regular', url: interRegular, style: 'Clean sans serif' },
  { id: 'oswald', label: 'Oswald', url: oswaldMedium, style: 'Narrow, good for long text' },
  { id: 'bebas', label: 'Bebas Neue', url: bebas, style: 'Tall capitals' },
  { id: 'roboto-slab', label: 'Roboto Slab Bold', url: robotoSlabBold, style: 'Slab serif' },
  { id: 'playfair', label: 'Playfair Display Bold', url: playfairBold, style: 'Elegant serif' },
  { id: 'jetbrains', label: 'JetBrains Mono Bold', url: jetbrainsBold, style: 'Monospace' },
  { id: 'orbitron', label: 'Orbitron Bold', url: orbitronBold, style: 'Rounded sci-fi' },
  { id: 'marker', label: 'Permanent Marker', url: marker, style: 'Hand drawn marker' },
  { id: 'caveat', label: 'Caveat Bold', url: caveatBold, style: 'Handwriting' },
  { id: 'pacifico', label: 'Pacifico', url: pacifico, style: 'Brush script' },
]

export const DEFAULT_FONT = 'inter-bold'

const cache = new Map<string, Promise<ArrayBuffer>>()

/** The font file bytes (fetched once from the app's own files, then kept). */
export function loadFontBytes(id: string): Promise<ArrayBuffer> {
  const def = FONTS.find((f) => f.id === id) ?? FONTS[0]
  let p = cache.get(def.id)
  if (!p) {
    p = fetch(def.url).then((r) => {
      if (!r.ok) throw new Error(`The font ${def.label} could not be loaded`)
      return r.arrayBuffer()
    })
    p.catch(() => cache.delete(def.id))
    cache.set(def.id, p)
  }
  return p
}
