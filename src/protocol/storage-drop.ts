import type { DroppedTree } from '../engine/ports/storage-drop.ts'
/** Blob capabilities are structured-cloned, never serialized as file bytes. */
export type BrowserDropTree = DroppedTree<Blob>
