import { BlobSource } from './blob-source.ts'
import { dropLimits, type DropResourceTree } from '../../engine/ports/storage-drop.ts'
import type { BrowserDropTree } from '../../protocol/storage-drop.ts'

/** Synchronous conversion at the Worker boundary. No archive sniffing, payload
 * reads, aliases or filesystem writes occur before the engine transaction. */
export function prepareDroppedResources(tree: BrowserDropTree): DropResourceTree {
  if (!tree || !Array.isArray(tree.roots) || !Array.isArray(tree.entries) ||
      tree.roots.length > dropLimits.roots || tree.entries.length > dropLimits.entries)
    throw new Error('Invalid dropped file tree')
  return {
    roots: tree.roots.map((root) => ({ name: root.name, kind: root.kind })),
    entries: tree.entries.map((entry) => {
      if (entry.kind === 'directory') return { root: entry.root, path: entry.path, kind: 'directory' }
      if (entry.kind !== 'file' || !(entry.source instanceof Blob)) throw new Error('Dropped item has no Blob capability')
      return { root: entry.root, path: entry.path, kind: 'file', source: new BlobSource(entry.source) }
    }),
  }
}
