import { test, expect, type App } from './helpers'
import type { Page } from '@playwright/test'

/**
 * Never reload on someone, and autosave to a real folder.
 *
 * Playwright's Chromium cannot drive the real directory picker, so most of this runs against `window.showDirectoryPicker` replaced by an
 * in-memory folder with the same shape (getDirectoryHandle / getFileHandle / createWritable with swap-on-close / removeEntry / entries /
 * values / queryPermission / requestPermission). The restart test uses the browser's own origin private file system instead, which is a
 * real handle that survives being stored in IndexedDB.
 */

/** Installed before the page loads. `memfs` is the in-memory folder; the picker hands it out. */
async function memFolder(page: Page, opts: { picker?: boolean } = {}) {
  await page.addInitScript((picker) => {
    const w = window as any // eslint-disable-line
    // the fixture switches autosave off for every spec; these specs are about it
    w.__e2eNoAutosave = false
    try {
      if (!localStorage.getItem('caddy.settings')) localStorage.setItem('caddy.settings', JSON.stringify({ tourSeen: true, autosaveSeconds: 15 }))
    } catch { /* storage unavailable */ }
    if (!picker) {
      Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true, writable: true })
      return
    }
    const nf = () => new DOMException('not found', 'NotFoundError')
    class MemFile {
      kind = 'file'
      bytes = new Uint8Array(0)
      mod = Date.now()
      constructor(public name: string) {}
      async getFile() { return new File([this.bytes as BlobPart], this.name, { lastModified: this.mod }) }
      async isSameEntry(o: unknown) { return o === this }
      async createWritable() {
        const chunks: Uint8Array[] = []
        const self = this
        return {
          async write(d: BufferSource) { chunks.push(new Uint8Array(await new Blob([d]).arrayBuffer())) },
          // like the browser: nothing lands in the real file until close() swaps the written copy in
          async close() {
            if (memfs.failWrites) { memfs.ops.push('fail:' + self.name); throw new DOMException('disk full', 'QuotaExceededError') }
            const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
            let o = 0
            for (const c of chunks) { out.set(c, o); o += c.length }
            self.bytes = out
            self.mod = Date.now()
            memfs.ops.push('close:' + self.name)
          },
          async abort() { chunks.length = 0; memfs.ops.push('abort:' + self.name) },
        }
      }
    }
    class MemDir {
      kind = 'directory'
      map = new Map<string, MemFile | MemDir>()
      constructor(public name: string) {}
      async getFileHandle(n: string, o?: { create?: boolean }) {
        let e = this.map.get(n)
        if (!e) { if (!o?.create) throw nf(); e = new MemFile(n); this.map.set(n, e) }
        if (e.kind !== 'file') throw new DOMException('mismatch', 'TypeMismatchError')
        return e as MemFile
      }
      async getDirectoryHandle(n: string, o?: { create?: boolean }) {
        let e = this.map.get(n)
        if (!e) { if (!o?.create) throw nf(); e = new MemDir(n); this.map.set(n, e) }
        if (e.kind !== 'directory') throw new DOMException('mismatch', 'TypeMismatchError')
        return e as MemDir
      }
      async removeEntry(n: string) { if (!this.map.delete(n)) throw nf() }
      async *entries() { for (const [k, v] of this.map) yield [k, v] as [string, MemFile | MemDir] }
      async *values() { for (const v of this.map.values()) yield v }
      async queryPermission() { return memfs.perm }
      async requestPermission() { memfs.requests++; if (memfs.perm !== 'denied') memfs.perm = 'granted'; return memfs.perm }
    }
    const root = new MemDir('Projects-stub')
    const memfs: any = { // eslint-disable-line
      root, perm: 'granted', requests: 0, failWrites: false, ops: [] as string[], picks: 0,
      names(dir = 'Autosave') { const d = root.map.get(dir) as MemDir | undefined; return d ? [...d.map.keys()].sort() : null },
      async bytes(path: string) { const [d, f] = path.split('/'); return Array.from(((await ((root.map.get(d) as MemDir).getFileHandle(f))).bytes)) },
      mtime(path: string) { const [d, f] = path.split('/'); return ((root.map.get(d) as MemDir | undefined)?.map.get(f) as MemFile | undefined)?.mod ?? 0 },
    }
    w.__memfs = memfs
    w.showDirectoryPicker = async () => { memfs.picks++; return root }
  }, opts.picker !== false)
}

/** Raw read of the browser copy idb-keyval keeps (without creating the database when it is not there yet). */
const idbCopy = (page: Page, key = 'caddy-autosave') =>
  page.evaluate(async (key) => {
    const dbs = await indexedDB.databases()
    if (!dbs.some((d) => d.name === 'keyval-store')) return null
    return new Promise<{ name: string; savedAt: number } | null>((res) => {
      const r = indexedDB.open('keyval-store')
      r.onerror = () => res(null)
      r.onsuccess = () => {
        try {
          const q = r.result.transaction('keyval').objectStore('keyval').get(key)
          q.onsuccess = () => res(q.result ? { name: q.result.name, savedAt: q.result.savedAt } : null)
          q.onerror = () => res(null)
        } catch { res(null) }
      }
    })
  }, key)

const idbDrop = (page: Page, key: string) =>
  page.evaluate(async (key) => {
    await new Promise<void>((res) => {
      const r = indexedDB.open('keyval-store')
      r.onsuccess = () => {
        const tx = r.result.transaction('keyval', 'readwrite')
        tx.objectStore('keyval').delete(key)
        tx.oncomplete = () => res()
        tx.onerror = () => res()
      }
      r.onerror = () => res()
    })
  }, key)

const addBox = (app: App, n = 1) => app.ev((c, n) => { for (let i = 0; i < n; i++) c.doc.getState().addFeature('box', { width: 10 + i, depth: 20, height: 20, position: [0, 0, 0] }) }, n)
const names = (page: Page, dir = 'Autosave') => page.evaluate((d) => (window as any).__memfs.names(d), dir) // eslint-disable-line
const featuresIn = (page: Page, path: string) =>
  page.evaluate(async (p) => { const w = window as any; return w.__caddy.parseProject(new Uint8Array(await w.__memfs.bytes(p))).data.features.length }, path) // eslint-disable-line
const flush = (app: App) => app.ev((c) => c.flushAutosave())
const openSettings = async (page: Page) => {
  await page.getByTestId('settings-gear').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await page.getByTestId('settings-dialog-nav-general').click()
}

// ---------------------------------------------------------------- never reload on someone

test('Update ready: quiet pill in the status bar, saves first, and only then switches', async ({ app, page }) => {
  await memFolder(page)
  await app.open()
  await expect(page.getByTestId('update-ready')).toHaveCount(0)

  // a folder is set up, and the document has unsaved work
  await app.ev(async (c) => { c.projects.setState({ root: (window as any).__memfs.root, access: 'granted' }) }) // eslint-disable-line
  await addBox(app, 2)
  expect(await idbCopy(page)).toBeNull()

  // what the page does when the new version is waiting and the person clicks: the stand-in for updateSW(true) looks at what was saved by then
  await page.evaluate(() => {
    const w = window as any // eslint-disable-line
    w.__updateCalls = []
    w.__caddy.updates.setUpdater(async (reload: boolean) => {
      const idb = await new Promise<boolean>((res) => {
        const r = indexedDB.open('keyval-store')
        r.onsuccess = () => { const q = r.result.transaction('keyval').objectStore('keyval').get('caddy-autosave'); q.onsuccess = () => res(!!q.result) }
        r.onerror = () => res(false)
      })
      w.__updateCalls.push({ reload, browserCopy: idb, folder: w.__memfs.names() })
    })
    w.__caddy.updates.markUpdateReady() // what the service worker's onNeedRefresh does
  })
  const pill = page.getByTestId('update-ready')
  await expect(pill).toBeVisible()
  await expect(pill).toHaveText('Update ready')
  // it lives in the status bar, small, and nothing else changed: no dialog, no reload
  expect(await pill.evaluate((el) => !!el.closest('.status'))).toBe(true)
  expect((await pill.boundingBox())!.height).toBeLessThan(30)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await app.shot('update-ready-pill')
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => (window as any).__updateCalls.length)).toBe(0) // eslint-disable-line

  await pill.click()
  await expect.poll(() => page.evaluate(() => (window as any).__updateCalls.length)).toBe(1) // eslint-disable-line
  const call = await page.evaluate(() => (window as any).__updateCalls[0]) // eslint-disable-line
  // the save finished before the switch started, in the browser and in the folder
  expect(call).toEqual({ reload: true, browserCopy: true, folder: ['Untitled.caddy'] })
  expect(await featuresIn(page, 'Autosave/Untitled.caddy')).toBe(2)
  // the page itself was not touched by the pill
  expect(await app.ev((c) => c.doc.getState().features.length)).toBe(2)
})

test('Update ready: a clean document has nothing to save and still switches; a take-over elsewhere asks for a reload instead of doing it', async ({ app, page }) => {
  await memFolder(page, { picker: false })
  await app.open()
  await page.evaluate(() => {
    const w = window as any // eslint-disable-line
    w.__updateCalls = 0
    w.__caddy.updates.setUpdater(async () => { w.__updateCalls++ })
    w.__caddy.updates.markUpdateReady()
  })
  await page.getByTestId('update-ready').click()
  await expect.poll(() => page.evaluate(() => (window as any).__updateCalls)).toBe(1) // eslint-disable-line
  expect(await idbCopy(page)).toBeNull()

  // another tab switched versions under this one: the pill changes its words, and the page is still not reloaded by itself
  await page.evaluate(() => (window as any).__caddy.updates.useUpdate.setState({ ready: true, switched: true, applying: false })) // eslint-disable-line
  await expect(page.getByTestId('update-ready')).toHaveText('Reload to update')
})

// ---------------------------------------------------------------- autosave to a folder

test('first launch card, then autosave writes <name>.caddy into Autosave/, keeps 3 versions and prunes the rest', async ({ app, page }) => {
  await memFolder(page)
  await app.open()

  // the one-time card: plain words, two buttons, not a modal
  const card = page.getByTestId('autosave-card')
  await expect(card).toBeVisible()
  await expect(card).toContainText('folder you pick')
  await expect(card.getByRole('button', { name: 'Pick folder' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Not now' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await app.shot('autosave-card')
  await card.getByRole('button', { name: 'Pick folder' }).click()
  await expect(card).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__memfs.picks)).toBe(1) // eslint-disable-line
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('caddy.settings') ?? '{}').autosaveFolderAsked)).toBe(true)
  // nothing is written for an empty, untouched document
  await page.waitForTimeout(300)
  expect(await names(page)).toBeNull()

  // the timer does it: real unsaved work, the 15 s interval of the settings
  await app.ev((c) => c.doc.setState({ name: 'Bracket' }))
  await addBox(app, 1)
  await expect.poll(async () => (await names(page)) ?? [], { timeout: 30_000, intervals: [500] }).toContain('Bracket.caddy')
  // (the timer is done proving itself: from here the specs ask for each save by hand, at a pace that does not depend on it)
  await app.ev((c) => c.settings.getState().setAutosaveSeconds(300))
  expect(await featuresIn(page, 'Autosave/Bracket.caddy')).toBe(1)
  await page.evaluate(() => (window as any).__memfs.root.map.get('Autosave').map.delete('Bracket~1.caddy')) // eslint-disable-line
  // the projects folder itself is left alone: only Autosave/ appeared in it
  expect(await page.evaluate(() => [...(window as any).__memfs.root.map.keys()])).toEqual(['Autosave']) // eslint-disable-line

  // more edits, more autosaves: 3 copies at most, the newest is Bracket.caddy
  for (let n = 2; n <= 5; n++) {
    await addBox(app, 1)
    await flush(app)
    expect(await featuresIn(page, 'Autosave/Bracket.caddy')).toBe(n)
  }
  expect(await names(page)).toEqual(['Bracket.caddy', 'Bracket~1.caddy', 'Bracket~2.caddy'])
  expect(await featuresIn(page, 'Autosave/Bracket~1.caddy')).toBe(4)
  expect(await featuresIn(page, 'Autosave/Bracket~2.caddy')).toBe(3)
  // swap-and-close writes only: no half files, no failed attempts
  expect(await page.evaluate(() => (window as any).__memfs.ops.filter((o: string) => !o.startsWith('close:')))).toEqual([]) // eslint-disable-line
  // the browser copy is still there too
  expect(await idbCopy(page)).toMatchObject({ name: 'Bracket' })

  // a second document keeps its own copies
  await app.ev((c) => c.doc.setState({ name: 'Lid' }))
  await flush(app)
  expect(await names(page)).toEqual(['Bracket.caddy', 'Bracket~1.caddy', 'Bracket~2.caddy', 'Lid.caddy'])

  // Settings > General: the folder and its name, and the number of copies to keep
  await openSettings(page)
  await expect(page.getByTestId('set-disk-autosave')).toBeVisible()
  await expect(page.getByTestId('autosave-folder-name')).toHaveText('Projects-stub')
  await expect(page.getByTestId('autosave-change-folder')).toHaveText('Change')
  await app.shot('settings-autosave-folder')
  await page.getByTestId('set-autosave-versions').getByRole('combobox').click()
  await page.getByRole('option', { name: '2', exact: true }).click()
  await app.ev((c) => c.doc.setState({ name: 'Bracket' }))
  await flush(app)
  expect(await names(page)).toEqual(['Bracket.caddy', 'Bracket~1.caddy', 'Lid.caddy'])
  expect(await featuresIn(page, 'Autosave/Bracket~1.caddy')).toBe(5)

  // turning the folder copies off stops folder writes (the browser copy goes on)
  const before = await page.evaluate(() => (window as any).__memfs.mtime('Autosave/Bracket.caddy')) // eslint-disable-line
  await page.getByRole('checkbox', { name: 'Keep copies in a folder' }).click()
  await expect(page.getByTestId('autosave-folder-name')).toHaveCount(0)
  await addBox(app, 1)
  await page.waitForTimeout(50)
  await flush(app)
  expect(await page.evaluate(() => (window as any).__memfs.mtime('Autosave/Bracket.caddy'))).toBe(before) // eslint-disable-line
  await page.keyboard.press('Escape')
})

test('autosave never overwrites the persons own saved file', async ({ app, page }) => {
  await memFolder(page)
  await app.open()
  await page.getByTestId('autosave-card-pick').click()
  await app.ev((c) => c.doc.setState({ name: 'Gear' }))
  await addBox(app, 1)
  await flush(app)
  expect(await names(page)).toEqual(['Gear.caddy'])
  // the person opens that very file from the Autosave folder and keeps working in it: saving goes back to it
  await app.ev((c) => c.doc.getState().markClean()) // (opening asks before it drops unsaved work)
  await page.evaluate(async () => {
    const w = window as any // eslint-disable-line
    const h = await (await w.__memfs.root.getDirectoryHandle('Autosave')).getFileHandle('Gear.caddy')
    const f = await h.getFile()
    await w.__caddy.openProjectFile(new Uint8Array(await f.arrayBuffer()), 'Gear.caddy', h)
  })
  const before = await page.evaluate(() => (window as any).__memfs.bytes('Autosave/Gear.caddy')) // eslint-disable-line
  await addBox(app, 2)
  await flush(app)
  expect(await page.evaluate(() => (window as any).__memfs.bytes('Autosave/Gear.caddy'))).toEqual(before) // eslint-disable-line
  expect(await names(page)).toEqual(['Gear (autosave).caddy', 'Gear.caddy'])
  expect(await featuresIn(page, 'Autosave/Gear (autosave).caddy')).toBe(3)
})

test('a folder that fails shows one toast, not one per attempt; access taken away shows the reconnect control, one click brings it back', async ({ app, page }) => {
  await memFolder(page)
  await app.open()
  await page.getByTestId('autosave-card-pick').click()
  await addBox(app, 1)
  await flush(app)
  expect(await names(page)).toEqual(['Untitled.caddy'])

  // count every toast the app raises
  await page.evaluate(() => {
    const w = window as any // eslint-disable-line
    w.__toasts = []
    w.__caddy.toast.subscribe((s: { msg: string | null }) => { if (s.msg) w.__toasts.push(s.msg) })
    w.__memfs.failWrites = true
  })
  await addBox(app, 1)
  for (let i = 0; i < 4; i++) await flush(app)
  const toasts = await page.evaluate(() => (window as any).__toasts as string[]) // eslint-disable-line
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('autosave folder')
  await expect(page.getByText('Could not write to the autosave folder')).toBeVisible()
  // the browser copy still took the work, and the old folder copy is whole
  expect(await idbCopy(page)).not.toBeNull()
  expect(await featuresIn(page, 'Autosave/Untitled.caddy')).toBe(1)
  expect(await names(page)).toEqual(['Untitled.caddy'])
  // when it works again the next failure is allowed to speak again
  await page.evaluate(() => { (window as any).__memfs.failWrites = false }) // eslint-disable-line
  await flush(app)
  expect(await featuresIn(page, 'Autosave/Untitled.caddy')).toBe(2)
  await page.evaluate(() => { (window as any).__memfs.failWrites = true }) // eslint-disable-line
  await addBox(app, 1)
  await flush(app)
  expect(await page.evaluate(() => (window as any).__toasts.length)).toBe(2) // eslint-disable-line
  await page.evaluate(() => { (window as any).__memfs.failWrites = false }) // eslint-disable-line

  // the browser asks again (Chrome does after a restart): a small control, no modal, no toast
  await expect(page.getByTestId('reconnect-autosave')).toHaveCount(0)
  await page.evaluate(() => { (window as any).__memfs.perm = 'prompt' }) // eslint-disable-line
  await flush(app)
  const reconnect = page.getByTestId('reconnect-autosave')
  await expect(reconnect).toBeVisible()
  await expect(reconnect).toHaveText('Reconnect autosave folder')
  expect(await reconnect.evaluate((el) => !!el.closest('.status'))).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__toasts.length)).toBe(2) // eslint-disable-line
  await app.shot('reconnect-autosave')
  const mod = await page.evaluate(() => (window as any).__memfs.mtime('Autosave/Untitled.caddy')) // eslint-disable-line
  await addBox(app, 1)
  await flush(app)
  expect(await page.evaluate(() => (window as any).__memfs.mtime('Autosave/Untitled.caddy'))).toBe(mod) // eslint-disable-line
  await reconnect.click()
  await expect(reconnect).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__memfs.requests)).toBe(1) // eslint-disable-line
  await flush(app)
  expect(await featuresIn(page, 'Autosave/Untitled.caddy')).toBe(4)
})

test('"Not now" is remembered and never nags again; Settings can still pick the folder', async ({ app, page }) => {
  await memFolder(page)
  await app.open()
  await page.getByTestId('autosave-card-later').click()
  await expect(page.getByTestId('autosave-card')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__memfs.picks)).toBe(0) // eslint-disable-line
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
  await page.waitForTimeout(800)
  await expect(page.getByTestId('autosave-card')).toHaveCount(0)
  // no folder yet: nothing is written, the browser copy does the job
  await addBox(app, 1)
  await flush(app)
  expect(await names(page)).toBeNull()
  expect(await idbCopy(page)).not.toBeNull()
  await openSettings(page)
  await expect(page.getByTestId('autosave-folder-name')).toHaveText('None')
  await page.getByTestId('autosave-change-folder').click()
  await expect(page.getByTestId('autosave-folder-name')).toHaveText('Projects-stub')
  await flush(app)
  expect(await names(page)).toEqual(['Untitled.caddy'])
})

test('a browser without folder access: no card, autosave stays in the browser, Settings says so in one line', async ({ app, page }) => {
  await memFolder(page, { picker: false })
  await app.open()
  await page.waitForTimeout(800)
  await expect(page.getByTestId('autosave-card')).toHaveCount(0)
  await addBox(app, 1)
  await flush(app)
  expect(await idbCopy(page)).not.toBeNull()
  await openSettings(page)
  const row = page.getByTestId('set-autosave-folder')
  await expect(row).toContainText('cannot save to a folder')
  await expect(row).toContainText('Chrome and Edge')
  await expect(page.getByTestId('autosave-change-folder')).toHaveCount(0)
  await expect(page.getByTestId('set-disk-autosave')).toHaveCount(0)
})

// ---------------------------------------------------------------- recovery across a restart

const FOLDER = 'autosave-e2e'
test('restart: the folder comes back on its own, a newer folder copy is offered once, a discarded or saved one is not', async ({ app, page }) => {
  // a real folder handle (the origin private file system), so it can be kept in IndexedDB like the real picker's
  await page.addInitScript((name) => {
    const w = window as any // eslint-disable-line
    w.__e2eNoAutosave = false
    try { if (!localStorage.getItem('caddy.settings')) localStorage.setItem('caddy.settings', JSON.stringify({ tourSeen: true })) } catch { /* none */ }
    w.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true })
  }, FOLDER)
  await app.open()
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(name, { recursive: true }).catch(() => {})
  }, FOLDER)
  await page.getByTestId('autosave-card-pick').click()
  await expect(page.getByTestId('autosave-card')).toHaveCount(0)
  await app.ev((c) => c.doc.setState({ name: 'Crashy' }))
  await addBox(app, 3)
  await flush(app)
  const opfs = () => page.evaluate(async (name) => {
    const d = await (await navigator.storage.getDirectory()).getDirectoryHandle(name).then((r) => r.getDirectoryHandle('Autosave')).catch(() => null)
    if (!d) return null
    const out: string[] = []
    for await (const [n] of (d as any).entries()) out.push(n) // eslint-disable-line
    return out.sort()
  }, FOLDER)
  expect(await opfs()).toEqual(['Crashy.caddy'])

  // 1. same save in the browser and the folder: the prompt is the ordinary one
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
  const dlg = page.getByRole('dialog')
  await expect(dlg).toContainText('Recover unsaved work?')
  await expect(dlg).toContainText('Crashy')
  await expect(dlg).not.toContainText('autosave folder')
  await expect(page.getByTestId('autosave-card')).toHaveCount(0) // the folder was remembered

  // 2. browser data cleared, the folder survived: the folder copy is offered
  await dlg.getByRole('button', { name: 'Discard' }).click()
  await expect(dlg).toHaveCount(0)
  expect(await idbCopy(page)).toBeNull()
  // (discarded: the older folder copy is not offered again)
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
  await page.waitForTimeout(1200)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // new work, a new folder copy; the browser copy is lost (cleared site data)
  await app.ev((c) => c.doc.setState({ name: 'Crashy' }))
  await addBox(app, 4)
  await flush(app)
  await idbDrop(page, 'caddy-autosave')
  expect(await idbCopy(page)).toBeNull()
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
  await expect(dlg).toContainText('autosave folder')
  await dlg.getByRole('button', { name: 'Recover' }).click()
  await expect(dlg).toHaveCount(0)
  await expect.poll(() => app.ev((c) => c.doc.getState().features.length)).toBe(4)
  expect(await app.ev((c) => c.doc.getState().name)).toBe('Crashy')
  expect(await app.ev((c) => c.doc.getState().dirty)).toBe(true)

  // 3. a project saved properly stops being offered: the folder copy is older than the save
  await app.ev(async (c) => { await c.saveDocument() }) // no file picker in the fixture: it downloads, and clears the recovery state
  await page.reload()
  await page.waitForFunction(() => !!(window as any).__caddy) // eslint-disable-line
  await page.waitForTimeout(1200)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
