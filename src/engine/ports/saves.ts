export const MAX_SAVE_BYTES = 64 * 1024 * 1024
export const MAX_SAVE_FILES = 10000
export type SaveScope = 'all' | 'data-directory'
export interface SaveFile {
  path: string
  bytes: Uint8Array
}
export interface SaveProfile {
  title: string
  directory: string
}
export interface SaveTransferSource {
  gameId: string
  profile?: SaveProfile
  updatedAt?: number
}
export interface SaveCopyResult {
  copied: number
  kept: number
}
export interface SaveStore {
  load(): Promise<SaveFile[]>
  /** Commit the entire batch atomically, or reject and retain the previous files. */
  commit(files: SaveFile[]): Promise<void>
  /** Read this namespace and apply synchronous conflict decisions in the
   * same write transaction, including against commits from another tab. */
  update?(plan: (stored: SaveFile[]) => SaveFile[]): Promise<void>
  close(): void
}
export class MemorySaveStore implements SaveStore {
  private files = new Map<string, Uint8Array>()
  async load(): Promise<SaveFile[]> {
    return [...this.files].map(([path, bytes]) => ({ path, bytes: bytes.slice() }))
  }
  async commit(files: SaveFile[]): Promise<void> {
    const owned = files.map(({ path, bytes }) => ({ path, bytes: Uint8Array.from(bytes) }))
    for (const file of owned) this.files.set(file.path, file.bytes)
  }
  async update(plan: (stored: SaveFile[]) => SaveFile[]): Promise<void> {
    const changes = plan([...this.files].map(([path, bytes]) => ({ path, bytes: bytes.slice() })))
    await this.commit(changes)
  }
  close(): void {}
}
