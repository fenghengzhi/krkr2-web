import { LibraryIndex } from '../../backends/files/library-index.ts'
import { OpfsLibraryFiles, OpfsReadPool } from '../../backends/files/opfs-library.ts'
import { HttpRangePool } from '../../backends/files/http-range.ts'
import { resolveFiles, type SourceFile } from '../../backends/files/source-files.ts'
import { gameIdentity } from '../game-identity.ts'
import type {
  LibraryGame,
  LibraryImport,
  LibraryProgress,
  LibraryStatus,
} from '../../protocol/library.ts'
import {
  LIBRARY_BLOCK_BYTES,
  LIBRARY_WRITE_LOCK,
  MAX_LIBRARY_GAMES,
  gameSettings,
  libraryId,
  libraryReadLock,
  summary,
  validateRecord,
  type LibraryRecord,
} from './records.ts'

export interface LibraryLease {
  files: SourceFile[]
  record: LibraryRecord
  close(): Promise<void>
}
export class LibraryService {
  constructor(
    private readonly index: Pick<LibraryIndex, 'get' | 'list' | 'put' | 'remove'>,
    private readonly files: Pick<OpfsLibraryFiles, 'write' | 'sources' | 'remove' | 'recover'>,
    private readonly locks: LockManager,
    private readonly storage: Pick<StorageManager, 'estimate' | 'persisted'>,
  ) {}
  static async open(): Promise<LibraryService> {
    if (
      !globalThis.navigator?.storage?.getDirectory ||
      !navigator.locks ||
      typeof FileSystemFileHandle === 'undefined' ||
      !('createSyncAccessHandle' in FileSystemFileHandle.prototype)
    )
      throw new Error('This browser cannot keep a game library; use temporary file loading')
    let files: OpfsLibraryFiles
    try {
      files = await OpfsLibraryFiles.open()
    } catch (error) {
      throw new Error(
        'Browser game storage is unavailable; try a regular browsing window. ' +
          (error instanceof Error ? error.message : String(error)),
      )
    }
    return new LibraryService(new LibraryIndex(), files, navigator.locks, navigator.storage)
  }
  async list(): Promise<LibraryStatus> {
    await this.locks.request(LIBRARY_WRITE_LOCK, { ifAvailable: true }, async (lock) => {
      if (lock)
        await this.files.recover(new Set((await this.index.list()).map((record) => record.id)))
    })
    const records = await this.index.list()
    const [estimate, persisted] = await Promise.allSettled([
      this.storage.estimate(),
      this.storage.persisted(),
    ])
    return {
      available: true,
      games: records.sort((a, b) => b.createdAt - a.createdAt).map(summary),
      ...(estimate.status === 'fulfilled' ? estimate.value : {}),
      persisted: persisted.status === 'fulfilled' && persisted.value,
    }
  }
  async importGame(
    request: LibraryImport,
    signal: AbortSignal,
    progress: (value: LibraryProgress) => void,
  ): Promise<LibraryGame> {
    signal.throwIfAborted()
    const settings = gameSettings(request)
    if (
      !/^game-[a-f0-9]{64}$/.test(request.expectedGameId) ||
      !Array.isArray(request.files) ||
      !request.files.length ||
      request.files.length > 10000
    )
      throw new Error('Invalid library import request')
    for (const file of request.files)
      if (typeof file.path !== 'string' || file.path.length > 1024)
        throw new Error('Library paths must not exceed 1024 characters')
    return this.locks.request(LIBRARY_WRITE_LOCK, { signal }, async () => {
      signal.throwIfAborted()
      const records = await this.index.list()
      await this.files.recover(new Set(records.map((record) => record.id)))
      if (records.length >= MAX_LIBRARY_GAMES)
        throw new Error('Library exceeds 256 games; remove an unused entry first')
      const http = new HttpRangePool({ cacheBytes: 0 })
      const cancel = () => http.close()
      signal.addEventListener('abort', cancel, { once: true })
      const id = 'entry-' + crypto.randomUUID(),
        readPool = new OpfsReadPool(signal)
      let published = false,
        completed = 0,
        total = 0,
        lastReport = 0
      const report = (phase: LibraryProgress['phase'], file = '') => {
        progress({ operation: request.operation, phase, completed, total, file })
        lastReport = performance.now()
      }
      try {
        report('preparing')
        const checkpoint = async () => {
          signal.throwIfAborted()
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          signal.throwIfAborted()
        }
        const sources = await resolveFiles(request.files, checkpoint, http)
        const identity = await gameIdentity(sources, checkpoint)
        if (identity !== request.expectedGameId)
          throw new Error('Game sources changed; reload the game before saving it to the library')
        total = sources.reduce((sum, file) => sum + file.source.size, 0)
        // Bound the complete manifest before allocating per-file hash arrays or writing bytes.
        const blocks = sources.reduce(
          (sum, file) => sum + Math.ceil(file.source.size / LIBRARY_BLOCK_BYTES),
          0,
        )
        if (!Number.isSafeInteger(total) || blocks > 65536)
          throw new Error('Library entry exceeds 65,536 data blocks')
        const record = validateRecord({
          version: 1,
          id,
          gameId: identity,
          ...settings,
          createdAt: Date.now(),
          size: total,
          fileCount: sources.length,
          files: sources.map((source) => ({
            path: source.path,
            size: source.source.size,
            hashes: Array(Math.ceil(source.source.size / LIBRARY_BLOCK_BYTES)).fill('0'.repeat(64)),
            ...(source.remoteIdentity === undefined
              ? {}
              : { remoteIdentity: source.remoteIdentity }),
          })),
        })
        const estimate = await this.storage.estimate().catch(() => ({}) as StorageEstimate)
        if (
          estimate.quota !== undefined &&
          estimate.usage !== undefined &&
          estimate.quota - estimate.usage <
            total + new TextEncoder().encode(JSON.stringify(record)).length
        )
          throw new DOMException('Not enough browser storage for this game', 'QuotaExceededError')
        for (const [index, source] of sources.entries()) {
          signal.throwIfAborted()
          report('copying', source.path)
          record.files[index] = await this.files.write(id, index, source, signal, (bytes) => {
            completed += bytes
            if (performance.now() - lastReport >= 50 || completed === total)
              report('copying', source.path)
          })
        }
        const stored = await this.files.sources(id, record.files, readPool, signal)
        if ((await gameIdentity(stored, checkpoint)) !== identity)
          throw new Error('Stored game identity does not match its source')
        signal.throwIfAborted()
        report('committing')
        await this.index.put(record, signal)
        published = true
        return summary(record)
      } finally {
        signal.removeEventListener('abort', cancel)
        http.close()
        readPool.close()
        // A terminated Worker may leave an orphan. Recovery under the same write lock removes it.
        if (!published) await this.files.remove(id).catch(() => {})
      }
    })
  }
  async acquire(id: string, signal: AbortSignal): Promise<LibraryLease> {
    libraryId(id)
    signal.throwIfAborted()
    const pool = new OpfsReadPool(signal)
    let release!: () => void
    const lifetime = new Promise<void>((resolve) => {
      release = resolve
    })
    const cancel = () => {
      pool.close()
      release()
    }
    signal.addEventListener('abort', cancel, { once: true })
    let accept!: (value: Omit<LibraryLease, 'close'>) => void, reject!: (error: unknown) => void
    const opened = new Promise<Omit<LibraryLease, 'close'>>((yes, no) => {
      accept = yes
      reject = no
    })
    const done = this.locks
      .request(libraryReadLock(id), { mode: 'shared', signal }, async () => {
        signal.throwIfAborted()
        const record = await this.index.get(id)
        const files = await this.files.sources(id, record.files, pool, signal)
        if (
          (await gameIdentity(files, async () => {
            signal.throwIfAborted()
          })) !== record.gameId
        )
          throw new Error('Library identity mismatch; import the game again')
        signal.throwIfAborted()
        accept({ record, files })
        await lifetime
      })
      .catch(reject)
      .finally(() => {
        signal.removeEventListener('abort', cancel)
        pool.close()
      })
    try {
      const lease = await opened
      signal.throwIfAborted()
      return {
        ...lease,
        close: async () => {
          cancel()
          await done
        },
      }
    } catch (error) {
      cancel()
      await done
      throw error
    }
  }
  async remove(id: string): Promise<void> {
    libraryId(id)
    await this.locks.request(LIBRARY_WRITE_LOCK, async () => {
      await this.locks.request(libraryReadLock(id), { ifAvailable: true }, async (lock) => {
        if (!lock)
          throw new Error(
            'This game is running in another tab; stop it before removing its resources',
          )
        await this.index.remove(id)
        await this.files.remove(id)
      })
    })
  }
  async update(
    id: string,
    settings: Pick<LibraryGame, 'title' | 'entry' | 'backend'>,
  ): Promise<void> {
    libraryId(id)
    const clean = gameSettings(settings)
    await this.locks.request(LIBRARY_WRITE_LOCK, async () => {
      await this.index.put({ ...(await this.index.get(id)), ...clean })
    })
  }
}
