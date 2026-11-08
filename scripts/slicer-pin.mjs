/** The pinned Muon3D engine release the app is built against. Shared by the fetch script, the Vite plugin and the service worker config. */
export const VERSION = '0.6.1'
export const RELEASE = `https://github.com/Muon-3D/muon3d-slicer-engine/releases/download/v${VERSION}`
// pinned, so a changed release cannot slip in: these are the values the release notes list
export const PINNED = {
  [`muon3d-slicer-engine-${VERSION}.tgz`]: '1c6b676e0405c387fb9742568f7b142b5cb2ac3942f05022ceb9769d87cac573',
  [`muon3d-slicer-profiles-${VERSION}.tgz`]: '8c349e2fd4f2318ce373e7a657de22047e303b900ed51a3a0ed3ba6fc6ee9f56',
}
