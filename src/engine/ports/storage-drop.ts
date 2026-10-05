import type { ByteSource } from './storage.ts'

export interface DropRoot { readonly name: string; readonly kind: 'file' | 'directory' }
export type DropEntry<T> = { readonly root: number; readonly path: string; readonly kind: 'directory' } |
  { readonly root: number; readonly path: string; readonly kind: 'file'; readonly source: T }
/** Top-level order is browser order. Each root has one path:'' entry; every
 * directory, including empty directories and parents, is explicitly present. */
export interface DroppedTree<T> { readonly roots: readonly DropRoot[]; readonly entries: readonly DropEntry<T>[] }
export type DropResourceTree = DroppedTree<ByteSource>
export const dropLimits = Object.freeze({
  roots: 256, entries: 10000, depth: 64, pathUnits: 4096, batchNameUnits: 2 * 1024 * 1024,
  batches: 256, files: 50000, directories: 50000, sessionNameUnits: 8 * 1024 * 1024,
  sourceBytes: 64 * 1024 ** 3, pendingReads: 32, pendingReadBytes: 128 * 1024 * 1024,
})
