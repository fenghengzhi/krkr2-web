import { MAX_SAVE_BYTES, MAX_SAVE_FILES, type SaveFile, type SaveProfile, type SaveStore, type SaveTransferSource } from '../../engine/ports/saves.ts'
import { normalizeResourcePath } from '../../engine/storage/public-path.ts'
// Separate from every game-* index key. Older players still read exactly
// their original file rows from the v1 database.
const profileNamespace = 'krkr2-save-profiles-v1'
const gameIdentity = /^game-[a-f0-9]{64}$/
interface ProfileRecord {
  path: string
  profile: SaveProfile
  updatedAt: number
}
interface SaveRecord {
  gameId: string
  path: string
  bytes: Uint8Array
  updatedAt: number
}
export class IndexedDbSaveStore implements SaveStore {
  private database?: Promise<IDBDatabase>
  constructor(private readonly gameId: string, private readonly profile?: () => SaveProfile) {
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
    await this.write(() => files, false)
  }
  async update(plan: (stored: SaveFile[]) => SaveFile[]): Promise<void> {
    await this.write(plan, true)
  }
  private async write(plan: (stored: SaveFile[]) => SaveFile[], readCurrent: boolean): Promise<void> {
    const database = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('saves', 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error ?? new Error('Save transaction aborted'))
      transaction.onerror = () => reject(transaction.error)
      const store = transaction.objectStore('saves')
      const apply = (stored: SaveFile[]) => {
        try {
          const files = plan(stored)
          const updatedAt = Date.now()
          for (const { path, bytes } of files) {
            store.put({ gameId: this.gameId, path, bytes: Uint8Array.from(bytes), updatedAt } satisfies SaveRecord)
          }
          if (files.length && this.profile) {
            store.put({ gameId: profileNamespace, path: this.gameId, profile: this.profile(), updatedAt })
          }
        } catch (error) {
          transaction.abort()
          reject(error)
        }
      }
      if (readCurrent) {
        const request = store.index('game').getAll(this.gameId, MAX_SAVE_FILES + 1)
        request.onsuccess = () => apply(request.result as SaveRecord[])
      } else apply([])
    })
  }
  async sources(): Promise<SaveTransferSource[]> {
    const database = await this.open()
    return new Promise((resolve, reject) => {
      const tx = database.transaction('saves', 'readonly')
      const index = tx.objectStore('saves').index('game')
      const ids: string[] = []
      const cursor = index.openKeyCursor(null, 'nextunique')
      const profiles = index.getAll(profileNamespace)
      cursor.onsuccess = () => {
        const item = cursor.result
        if (!item) return
        if (typeof item.key === 'string' && gameIdentity.test(item.key) && item.key !== this.gameId) ids.push(item.key)
        item.continue()
      }
      tx.onabort = () => reject(tx.error ?? new Error('无法读取其他版本的存档'))
      tx.oncomplete = () => {
        const byId = new Map((profiles.result as ProfileRecord[]).map((row) => [row.path, row]))
        const versions = ids.map((gameId) => {
          const row = byId.get(gameId)
          return { gameId, profile: row?.profile, updatedAt: row?.updatedAt }
        })
        resolve(versions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)))
      }
    })
  }
  private checkSource(id: string) {
    if (id === this.gameId || !gameIdentity.test(id)) throw new Error('请选择另一个版本的存档')
  }
  async sourcePaths(id: string): Promise<string[]> {
    this.checkSource(id)
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('saves', 'readonly')
      const keys = tx.objectStore('saves').index('game').getAllKeys(id, MAX_SAVE_FILES + 1)
      tx.onabort = () => reject(tx.error ?? new Error('无法读取存档目录'))
      tx.oncomplete = () => {
        if (keys.result.length > MAX_SAVE_FILES) reject(new Error('存档文件数量超过限制'))
        else resolve(keys.result.map((key) => (key as [string, string])[1]))
      }
    })
  }
  async readDirectory(id: string, directory: string): Promise<SaveFile[]> {
    this.checkSource(id)
    if (directory !== '' && (typeof directory !== 'string' || directory.length > 4096 || directory.includes('>') ||
      normalizeResourcePath(directory) + '/' !== directory)) throw new Error('无效的存档目录')
    const db = await this.open()
    const lower = directory.toLowerCase(), depth = directory.split('/').length - 1
    return new Promise((resolve, reject) => {
      const tx = db.transaction('saves', 'readonly'), store = tx.objectStore('saves')
      const cursor = store.index('game').openKeyCursor(id)
      const files: SaveFile[] = []
      let total = 0, count = 0
      const fail = (message: string) => {
        reject(new Error(message))
        tx.abort()
      }
      cursor.onsuccess = () => {
        const item = cursor.result
        if (!item) return
        if (++count > MAX_SAVE_FILES) { fail('存档文件数量超过限制'); return }
        const path = (item.primaryKey as [string, string])[1]
        if (!path.toLowerCase().startsWith(lower)) { item.continue(); return }
        const read = store.get(item.primaryKey)
        read.onsuccess = () => {
          const { bytes } = read.result as SaveRecord
          if (!(bytes instanceof Uint8Array) || (total += bytes.byteLength) > MAX_SAVE_BYTES) {
            fail('来源存档无效或超过大小限制')
            return
          }
          files.push({ path: path.split('/').slice(depth).join('/'), bytes })
          item.continue()
        }
      }
      tx.onabort = () => reject(tx.error ?? new Error('读取旧版本存档失败'))
      tx.oncomplete = () => files.length ? resolve(files) : reject(new Error('所选目录中没有已保存的文件'))
    })
  }
  close(): void {
    void this.database?.then(
      (database) => database.close(),
      () => undefined,
    )
  }
}
