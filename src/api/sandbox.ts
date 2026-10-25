/**
 * The sandbox a plugin runs in.
 *
 * In the browser: a hidden <iframe sandbox="allow-scripts"> (no same-origin access, so no DOM, cookies or storage of the app)
 * whose own CSP forbids every network request, which starts a Web Worker from a blob. The worker inherits that CSP, runs the
 * runtime (runtime/runtime.js) and then the plugin. The only link back to the app is a MessagePort, handed over at start; the
 * iframe cannot see it again.
 *
 * localTransport.ts runs the same runtime in this thread over a MessageChannel, for the unit tests.
 */
import linkSrc from './runtime/link.js?raw'
import surfaceSrc from './runtime/surface.js?raw'
import runtimeSrc from './runtime/runtime.js?raw'

/** The sources are ES modules for the tests; in the worker they are one script, so exports lose `export` and imports go. */
const stripExports = (s: string) => s.replace(/^import\s.*$/gm, '').replace(/^export\s+/gm, '')

/** What the worker runs first: the surface list, the linker and the runtime, then `boot`. */
export const RUNTIME_SOURCE = `${stripExports(surfaceSrc)}\n${stripExports(linkSrc)}\n${stripExports(runtimeSrc)}\nboot(self);\n`

/** The CSP of the sandbox: scripts and workers only from blobs it makes itself, no connections of any kind. */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'"

const BOOT_HTML = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><script>
window.addEventListener('message', function (e) {
  var d = e.data
  if (!d || d.t !== 'boot') return
  try {
    var w = new Worker(URL.createObjectURL(new Blob([d.runtime], { type: 'text/javascript' })))
    w.onerror = function (ev) { e.source.postMessage({ t: 'crash', message: (ev && ev.message) || 'The plugin stopped' }, '*') }
    w.postMessage({ t: 'init', modules: d.modules, entry: d.entry }, [e.ports[0]])
  } catch (err) {
    e.source.postMessage({ t: 'crash', message: String(err) }, '*')
  }
})
</script>`

/** One plugin's line to the host. */
export interface Transport {
  post(msg: unknown, transfer?: Transferable[]): void
  onMessage(fn: (msg: any) => void): void // eslint-disable-line @typescript-eslint/no-explicit-any
  /** the sandbox died (a script error outside any call, the worker was killed) */
  onCrash(fn: (reason: string) => void): void
  terminate(): void
}

export function createIframeTransport(files: Record<string, string>, entry: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none'
    frame.srcdoc = BOOT_HTML
    const { port1, port2 } = new MessageChannel()
    let crash: ((r: string) => void) | null = null
    const onWindow = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || !e.data || e.data.t !== 'crash') return
      crash?.(String(e.data.message ?? 'The plugin stopped'))
    }
    window.addEventListener('message', onWindow)
    const transport: Transport = {
      post: (m, t) => port1.postMessage(m, t ?? []),
      onMessage: (fn) => { port1.onmessage = (ev) => fn(ev.data) },
      onCrash: (fn) => { crash = fn },
      terminate: () => {
        window.removeEventListener('message', onWindow)
        port1.close()
        frame.remove()
      },
    }
    frame.onload = () => {
      frame.onload = null
      frame.contentWindow!.postMessage({ t: 'boot', runtime: RUNTIME_SOURCE, modules: files, entry }, '*', [port2])
      resolve(transport)
    }
    frame.onerror = () => reject(new Error('The plugin sandbox could not start'))
    document.body.appendChild(frame)
  })
}
