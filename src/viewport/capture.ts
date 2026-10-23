/** Lets non-React code (project save) grab a thumbnail of the viewport. Registered by Scene. */
type Capture = () => Promise<Uint8Array | null>
let fn: Capture | null = null
export const setCapture = (f: Capture | null) => { fn = f }
export const captureThumbnail = (): Promise<Uint8Array | null> => (fn ? fn().catch(() => null) : Promise.resolve(null))
