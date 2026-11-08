/**
 * Worker entry that starts the engine's host on a page that is not cross-origin isolated.
 *
 * Without isolation `SharedArrayBuffer` does not exist, and the 0.6.1 host's heap check does `memory.buffer instanceof
 * SharedArrayBuffer` even for the single-threaded engine, which throws a ReferenceError. A stand-in class that no memory is
 * an instance of makes that check answer "not shared", which is the truth. The host's own isolation check
 * (`crossOriginIsolated`) still says threads are off, so `st` is the only variant it offers.
 *
 * Once the host module has run (it listens for messages as it loads), this posts `{ booted: true }`; the client waits for
 * that before it says hello, so no message arrives before the host listens.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope & { SharedArrayBuffer?: unknown }

scope.addEventListener('message', function boot(e: MessageEvent) {
  const data = e.data as { boot?: string } | null
  if (!data?.boot) return
  scope.removeEventListener('message', boot)
  if (typeof scope.SharedArrayBuffer === 'undefined') scope.SharedArrayBuffer = class SharedArrayBuffer {}
  void import(/* @vite-ignore */ data.boot).then(
    () => scope.postMessage({ booted: true }),
    (err: unknown) => scope.postMessage({ booted: false, error: String(err) }),
  )
})
