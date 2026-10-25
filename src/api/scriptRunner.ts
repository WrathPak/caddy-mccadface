/** Runs the Script panel's text as a one-off plugin: same sandbox, same API, all permissions (the person typing it is the author). */
import { create } from 'zustand'
import { PluginHost, type LogLine } from './host'
import { PERMISSIONS } from './runtime/surface.js'
import { createIframeTransport } from './sandbox'
import { appServices } from './services'

export interface ScriptLine { level: LogLine['level'] | 'result'; text: string }

export const useScript = create<{ lines: ScriptLine[]; running: boolean; clear: () => void }>((set) => ({
  lines: [],
  running: false,
  clear: () => set({ lines: [] }),
}))

let host: PluginHost | null = null
let runs = 0

const push = (line: ScriptLine) => useScript.setState((s) => ({ lines: [...s.lines.slice(-499), line] }))

/** Stop the script and take back what it registered. */
export function stopScript() {
  host?.stop()
  host = null
  useScript.setState({ running: false })
}

/** Run `code`. Resolves when the script has finished its top level (a command or listener it registered keeps working until stopScript). */
export async function runScript(code: string): Promise<void> {
  stopScript()
  const run = ++runs
  const h = new PluginHost({ id: 'script', name: 'Script', files: { 'script.js': code }, entry: 'script.js', granted: [...PERMISSIONS] }, appServices(), (spec) => createIframeTransport(spec.files, spec.entry))
  host = h
  h.onLog = (l) => push({ level: l.level, text: l.text })
  useScript.setState({ running: true })
  push({ level: 'info', text: `Running (${new Date().toLocaleTimeString()})` })
  await h.start()
  if (run !== runs) return // another run started meanwhile
  if (h.state === 'failed') {
    push({ level: 'error', text: h.error ?? 'The script failed' })
    host = null
    useScript.setState({ running: false })
    return
  }
  for (const p of h.problems) push({ level: 'error', text: p })
  const kept = h.features.length + h.commands.length + h.listening
  push({ level: 'info', text: kept ? 'Done. What it registered or listens to stays active until you press Stop.' : 'Done.' })
  if (!kept) { h.stop(); host = null }
  useScript.setState({ running: kept > 0 })
}

export const scriptHost = () => host
