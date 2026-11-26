import {
  LIBRARY_DATABASE,
  validateRecord,
  validateDownload,
  validateSummary,
  summary,
  type LibraryRecord,
  type LibraryDownloadRecord,
} from '../../player/library/records.ts'
import type { LibraryGame, LibraryImport } from '../../protocol/library.ts'
import type { RemoteGameFile } from '../../protocol/session.ts'

export type RemoteLibraryImport = Omit<LibraryImport, 'files' | 'operation'> & { files: RemoteGameFile[] }
const downloadStores = ['downloads', 'downloadRequests', 'downloadBlocks']
function dropDownload(transaction: IDBTransaction, id: string): void {
  transaction.objectStore('downloads').delete(id)
  transaction.objectStore('downloadRequests').delete(id)
  transaction.objectStore('downloadBlocks').delete(IDBKeyRange.bound([id, 0, 0], [id, 10000, 65536]))
}

/** Each operation resolves only when its IDB transaction has committed. */
export class LibraryIndex {
  private database?: Promise<IDBDatabase>
  constructor(private readonly factory: IDBFactory = indexedDB) {}
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(LIBRARY_DATABASE, 3)
      let failed = false
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'id' })
        db.createObjectStore('downloads', { keyPath: 'id' })
        db.createObjectStore('downloadRequests')
        db.createObjectStore('downloadBlocks')
        if (db.objectStoreNames.contains('catalog')) return
        const catalog = db.createObjectStore('catalog', { keyPath: 'id' })
        const cursor = request.transaction!.objectStore('games').openCursor()
        cursor.onsuccess = () => {
          if (!cursor.result) return
          try {
            catalog.put(summary(validateRecord(cursor.result.value)))
            cursor.result.continue()
          } catch {
            request.transaction!.abort()
          }
        }
      }
      request.onblocked = () => {
        failed = true
        reject(new Error('Close other library tabs before upgrading storage'))
      }
      request.onerror = () => {
        failed = true
        reject(request.error)
      }
      request.onsuccess = () => {
        const db = request.result
        if (failed) {
          db.close()
          return
        }
        db.onversionchange = () => {
          db.close()
          this.database = undefined
        }
        resolve(db)
      }
    })
    this.database = opening.catch((error) => {
      this.database = undefined
      throw error
    })
    return this.database
  }
  private async transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
    signal?: AbortSignal,
    stores: string[] = ['games'],
  ): Promise<T> {
    signal?.throwIfAborted()
    const db = await this.open()
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(
        stores,
        mode,
        mode === 'readwrite' ? { durability: 'strict' } : undefined,
      )
      let failure: unknown
      const cancel = () => {
        try {
          transaction.abort()
        } catch {
          /* Already committed or aborted. */
        }
      }
      signal?.addEventListener('abort', cancel, { once: true })
      const clear = () => signal?.removeEventListener('abort', cancel)
      transaction.onabort = () => {
        clear()
        reject(
          failure ??
            (signal?.aborted
              ? signal.reason
              : (transaction.error ?? new Error('Library transaction aborted'))),
        )
      }
      let request: IDBRequest<T>
      transaction.oncomplete = () => {
        clear()
        resolve(request.result)
      }
      try {
        request = operation(transaction.objectStore(stores[0]!))
        if (signal?.aborted) cancel()
      } catch (error) {
        failure = error
        cancel()
      }
    })
  }
  async catalog(): Promise<{ games: LibraryGame[]; downloads: LibraryDownloadRecord[] }> {
    let pending!: IDBRequest<unknown[]>
    const records = await this.transaction('readonly', (store) => {
      pending = store.transaction.objectStore('downloads').getAll()
      return store.getAll()
    }, undefined, ['catalog', 'downloads'])
    return { games: records.map(validateSummary), downloads: pending.result.map(validateDownload) }
  }
  async list(): Promise<LibraryGame[]> {
    return (await this.catalog()).games
  }
  async get(id: string): Promise<LibraryRecord> {
    const record = await this.transaction('readonly', (store) => store.get(id))
    if (!record) throw new Error('This game is no longer in the library')
    return validateRecord(record)
  }
  async startDownload(item: LibraryDownloadRecord, request: RemoteLibraryImport | undefined, signal: AbortSignal) {
    validateDownload(item)
    await this.transaction('readwrite', (store) => {
      if (request) store.transaction.objectStore('downloadRequests').add(request, item.id)
      return store.add(item)
    }, signal, ['downloads', 'downloadRequests'])
  }
  async requestFor(id: string): Promise<RemoteLibraryImport> {
    const request = await this.transaction('readonly', (store) => store.get(id), undefined, ['downloadRequests'])
    if (!request || !Array.isArray(request.files) || !request.files.length || request.files.length > 10000 ||
        request.files.some((file: RemoteGameFile) => !file || typeof file.url !== 'string' || typeof file.path !== 'string' || 'blob' in file))
      throw new Error('重新载入原来的文件后才能继续这项下载。')
    return request
  }
  async hashes(id: string, file: number, signal: AbortSignal): Promise<Map<number, string>> {
    const range = IDBKeyRange.bound([id, file, 0], [id, file, 65535])
    const rows = await this.transaction('readonly', (store) => store.getAll(range), signal, ['downloadBlocks'])
    const hashes = new Map<number, string>()
    for (const row of rows) {
      if (Array.isArray(row) && Number.isInteger(row[0]) && row[0] >= 0 && row[0] < 65536 &&
          typeof row[1] === 'string' && /^[a-f0-9]{64}$/.test(row[1])) hashes.set(row[0], row[1])
    }
    return hashes
  }
  async saveHash(id: string, file: number, block: number, hash: string, signal: AbortSignal): Promise<void> {
    await this.transaction('readwrite', (store) => store.put([block, hash], [id, file, block]), signal, ['downloadBlocks'])
  }
  async put(record: LibraryRecord, signal?: AbortSignal): Promise<void> {
    validateRecord(record)
    await this.transaction(
      'readwrite',
      (store) => {
        store.transaction.objectStore('catalog').put(summary(record))
        dropDownload(store.transaction, record.id)
        return store.put(record)
      },
      signal,
      ['games', 'catalog', ...downloadStores],
    )
  }
  async remove(id: string): Promise<void> {
    await this.transaction(
      'readwrite',
      (store) => {
        store.transaction.objectStore('catalog').delete(id)
        dropDownload(store.transaction, id)
        return store.delete(id)
      },
      undefined,
      ['games', 'catalog', ...downloadStores],
    )
  }
  close(): void {
    void this.database?.then(
      (db) => db.close(),
      () => {},
    )
    this.database = undefined
  }
}
