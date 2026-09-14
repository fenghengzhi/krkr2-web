export interface SaveFile {
  path: string
  bytes: Uint8Array
}
export interface SaveStore {
  load(): Promise<SaveFile[]>
  commit(files: SaveFile[]): Promise<void>
  close(): void
}
export class MemorySaveStore implements SaveStore {
  private files = new Map<string, Uint8Array>()
  async load(): Promise<SaveFile[]> {
    return [...this.files].map(([path, bytes]) => ({ path, bytes: bytes.slice() }))
  }
  async commit(files: SaveFile[]): Promise<void> {
    for (const file of files) this.files.set(file.path, file.bytes.slice())
  }
  close(): void {}
}
