import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'dist-e2e')
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')

function newestSource(dir: string): number {
  let m = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    m = Math.max(m, e.isDirectory() ? newestSource(p) : fs.statSync(p).mtimeMs)
  }
  return m
}

/**
 * A production bundle with the debug handle switched on (VITE_E2E=1), built into dist-e2e when the sources changed, served by
 * `vite preview`. The big-mesh spec measures this instead of the dev server: React's development build logs every component
 * render, which alone costs tens of milliseconds per update and would swamp the numbers.
 */
export async function startProdServer(port: number): Promise<() => void> {
  const stamp = path.join(out, 'index.html')
  const newest = Math.max(newestSource(path.join(root, 'src')), fs.statSync(path.join(root, 'package.json')).mtimeMs, fs.statSync(path.join(root, 'vite.config.ts')).mtimeMs)
  if (!fs.existsSync(stamp) || fs.statSync(stamp).mtimeMs < newest) {
    execFileSync(process.execPath, [vite, 'build', '--outDir', out, '--emptyOutDir'], { cwd: root, env: { ...process.env, VITE_E2E: '1' }, stdio: 'inherit' })
  }
  const child: ChildProcess = spawn(process.execPath, [vite, 'preview', '--outDir', out, '--port', String(port), '--strictPort', '--host', 'localhost'], { cwd: root, stdio: 'ignore' })
  const up = () => new Promise<boolean>((res) => {
    const r = http.get({ host: 'localhost', port, path: '/' }, (resp) => { resp.resume(); res(resp.statusCode === 200) })
    r.on('error', () => res(false))
  })
  for (let i = 0; i < 100; i++) {
    if (await up()) return () => void child.kill()
    await new Promise((r) => setTimeout(r, 300))
  }
  child.kill()
  throw new Error('vite preview did not start')
}
