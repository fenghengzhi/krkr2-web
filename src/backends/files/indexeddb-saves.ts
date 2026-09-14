import type { SaveFile, SaveStore } from '../../engine/ports/saves.ts'
interface SaveRecord {
  gameId: string
  path: string
  bytes: Uint8Array
  updatedAt: number
}
export class IndexedDbSaveStore implements SaveStore {
  private database?: Promise<IDBDatabase>
  constructor(private readonly gameId: string) {
    if (!gameId || gameId.length > 200) throw new Error('Invalid game identity')
  }
  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('krkr2-web', 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('saves', { keyPath: ['gameId', 'path'] })
        store.createIndex('game', 'gameId')
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () =>
        reject(new Error('Close other krkr2-web tabs to upgrade save storage'))
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close()
        resolve(request.result)
      }
    })
    return this.database
  }
  async load(): Promise<SaveFile[]> {
    const database = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('saves', 'readonly')
      const request = transaction.objectStore('saves').index('game').getAll(this.gameId)
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('Save read transaction aborted'))
      transaction.onerror = () => reject(transaction.error)
      transaction.oncomplete = () =>
        resolve(
          (request.result as SaveRecord[]).map(({ path, bytes }) => ({
            path,
            bytes: new Uint8Array(bytes),
          })),
        )
    })
  }
  async commit(files: SaveFile[]): Promise<void> {
    const database = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('saves', 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('Save transaction aborted'))
      transaction.onerror = () => reject(transaction.error)
      const store = transaction.objectStore('saves')
      for (const { path, bytes } of files)
        store.put({
          gameId: this.gameId,
          path,
          bytes: Uint8Array.from(bytes),
          updatedAt: Date.now(),
        } satisfies SaveRecord)
    })
  }
  close(): void {
    void this.database?.then(
      (database) => database.close(),
      () => undefined,
    )
  }
}
