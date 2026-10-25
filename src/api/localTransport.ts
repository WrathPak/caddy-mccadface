/** The sandbox runtime run in this thread over a MessageChannel: the same messages as the real sandbox, without the isolation. For unit tests. */
import { boot } from './runtime/runtime.js'
import type { Transport } from './sandbox'

/** Run the runtime in this thread (tests): same messages, no isolation. */
export function createLocalTransport(files: Record<string, string>, entry: string, env: { makeUrl?: (text: string) => string; load?: (url: string) => Promise<unknown> } = {}): Transport {
  const { port1, port2 } = new MessageChannel()
  const scope: Record<string, unknown> = { console: { log() {}, info() {}, warn() {}, error() {} } }
  const makeUrl = env.makeUrl ?? ((text: string) => 'data:text/javascript;base64,' + Buffer.from(text, 'utf8').toString('base64'))
  boot(scope, { makeUrl, load: env.load ?? ((url: string) => import(/* @vite-ignore */ url)) })
  ;(scope.onmessage as (e: unknown) => void)({ data: { t: 'init', modules: files, entry }, ports: [port2] })
  return {
    post: (m, t) => port1.postMessage(m, t ?? []),
    onMessage: (fn) => { port1.onmessage = (ev) => fn(ev.data) },
    onCrash: () => {},
    terminate: () => { port1.close(); port2.close() },
  }
}
