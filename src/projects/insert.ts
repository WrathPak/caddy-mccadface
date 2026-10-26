import type { FileNode } from './library'

/**
 * How the Projects panel inserts a project as a component of the open one. The assembly code sets this when it is loaded, so
 * the "Insert as component" menu entry only shows up where that command exists.
 */
export const componentInserter: { fn: ((node: FileNode, linked: boolean) => Promise<void>) | null } = { fn: null }
