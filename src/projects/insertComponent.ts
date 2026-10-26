/** "Insert as component" in the Projects panel: the assembly insert commands, fed from a file of the project folder instead of a file picker. */
import { activateOcc } from '@/assembly/actions'
import { insertExternal } from '@/assembly/external'
import { useSketch } from '@/sketch/store'
import { useUi } from '@/store/ui'
import { toast } from '@/ui/Modal'
import { componentInserter } from './insert'
import type { FileNode } from './library'

/**
 * Same result as Assemble > Insert Linked / Insert Embedded Copy. A linked component keeps the file handle, so the app can tell
 * when the file in the folder changes; a copy is stored in the document and never changes.
 */
export async function insertProject(node: FileNode, linked: boolean) {
  if (useSketch.getState().active) return toast('Finish the sketch first, then insert the component.', 'error')
  try {
    const file = await node.handle.getFile()
    const bytes = new Uint8Array(await file.arrayBuffer())
    const r = await insertExternal(bytes, node.name, { linked, stamp: file.lastModified, handle: linked ? (node.handle as never) : null })
    toast(linked ? `Inserted ${node.name} as a linked component. It is checked against the file whenever you come back to this window.` : `Inserted a copy of ${node.name} into this document.`)
    activateOcc(null)
    useUi.getState().setSelection([{ kind: 'component', id: r.path }])
  } catch (e) {
    toast(`Insert failed: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}

componentInserter.fn = insertProject
