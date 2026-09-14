import {
  LIBRARY_DATABASE,
  validateRecord,
  validateSummary,
  summary,
  type LibraryRecord,
} from '../../player/library/records.ts'
import type { LibraryGame } from '../../protocol/library.ts'

/** Each operation resolves only when its IDB transaction has committed. */
export class LibraryIndex {
  private database?: Promise<IDBDatabase>
  constructor(private readonly factory: IDBFactory = indexedDB) {}
  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(LIBRARY_DATABASE, 2)
      let failed = false
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'id' })
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
  async list(): Promise<LibraryGame[]> {
    const records = await this.transaction('readonly', (store) => store.getAll(), undefined, [
      'catalog',
    ])
    return records.map(validateSummary)
  }
  async get(id: string): Promise<LibraryRecord> {
    const record = await this.transaction('readonly', (store) => store.get(id))
    if (!record) throw new Error('This game is no longer in the library')
    return validateRecord(record)
  }
  async put(record: LibraryRecord, signal?: AbortSignal): Promise<void> {
    validateRecord(record)
    await this.transaction(
      'readwrite',
      (store) => {
        store.transaction.objectStore('catalog').put(summary(record))
        return store.put(record)
      },
      signal,
      ['games', 'catalog'],
    )
  }
  async remove(id: string): Promise<void> {
    await this.transaction(
      'readwrite',
      (store) => {
        store.transaction.objectStore('catalog').delete(id)
        return store.delete(id)
      },
      undefined,
      ['games', 'catalog'],
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
