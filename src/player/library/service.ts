import { LibraryIndex } from '../../backends/files/library-index.ts'
import { OpfsLibraryFiles, OpfsReadPool, hashBlock } from '../../backends/files/opfs-library.ts'
import { HttpRangePool, remoteUrl } from '../../backends/files/http-range.ts'
import { resolveFiles, type SourceFile } from '../../backends/files/source-files.ts'
import { gameIdentity, projectIdentity } from '../game-identity.ts'
import { copyGameEncodings, copyGameProject } from '../../engine/storage/project.ts'
import { prepareProject } from '../../engine/storage/distribution.ts'
import { importSources } from '../../backends/files/import-resources.ts'
import { createSessionArchiveReader } from '../../backends/files/archive-reader.ts'
import type {
  LibraryGame,
  LibraryImportRequest,
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
    private readonly index: Pick<LibraryIndex, 'get' | 'catalog' | 'startDownload' | 'requestFor' | 'hashes' | 'saveHash' | 'put' | 'remove'>,
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
    const { games, downloads } = await this.locks.request(LIBRARY_WRITE_LOCK, { ifAvailable: true }, async (lock) => {
      const catalog = await this.index.catalog()
      if (lock) await this.files.recover(new Set([...catalog.games, ...catalog.downloads].map((record) => record.id)))
      return catalog
    })
    const [estimate, persisted] = await Promise.allSettled([
      this.storage.estimate(),
      this.storage.persisted(),
    ])
    return {
      available: true,
      games: games.sort((a, b) => b.createdAt - a.createdAt).map(summary),
      downloads: downloads.map(({ id, title, gameId, size, reopenable }) => ({ id, title, gameId, size, reopenable })),
      ...(estimate.status === 'fulfilled' ? estimate.value : {}),
      persisted: persisted.status === 'fulfilled' && persisted.value,
    }
  }
  async importGame(
    input: LibraryImportRequest,
    signal: AbortSignal,
    progress: (value: LibraryProgress) => void,
  ): Promise<LibraryGame> {
    signal.throwIfAborted()
    return this.locks.request(LIBRARY_WRITE_LOCK, { signal }, async () => {
      signal.throwIfAborted()
      const { games, downloads } = await this.index.catalog()
      await this.files.recover(new Set([...games, ...downloads].map((item) => item.id)))
      const downloadId = 'download' in input ? libraryId(input.download) : undefined
      const selected = downloadId ? downloads.find((item) => item.id === downloadId) : undefined
      if ('download' in input && !selected) throw new Error('这项下载已经完成或已被移除。')
      if (selected && !selected.reopenable) throw new Error('请重新选择本地文件，然后保存当前游戏以继续下载。')
      const request = 'download' in input
        ? { ...await this.index.requestFor(input.download), operation: input.operation } : input
      if (selected && request.expectedGameId !== selected.gameId) throw new Error('保存的下载来源与游戏版本不符。')
      const requestedProject = copyGameProject(request.project)
      const encodings = copyGameEncodings(request)
      const settings = gameSettings(request, requestedProject)
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
      if (games.length >= MAX_LIBRARY_GAMES)
        throw new Error('Library exceeds 256 games; remove an unused entry first')
      const http = new HttpRangePool({ cacheBytes: 0 })
      const cancel = () => http.close()
      signal.addEventListener('abort', cancel, { once: true })
      const readPool = new OpfsReadPool(signal)
      let id = 'entry-' + crypto.randomUUID(), durable = false, published = false, reused = 0,
        completed = 0,
        total = 0,
        lastReport = 0
      const report = (phase: LibraryProgress['phase'], file = '') => {
        progress({ operation: request.operation, phase, completed, total, file, ...(reused ? { reused } : {}) })
        lastReport = performance.now()
      }
      try {
        report('preparing')
        let deadline = performance.now() + 8
        const checkpoint = async () => {
          signal.throwIfAborted()
          if (performance.now() >= deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
            deadline = performance.now() + 8
            signal.throwIfAborted()
          }
        }
        const sources = await resolveFiles(request.files, checkpoint, http)
        const sourceGameId = await gameIdentity(sources, checkpoint)
        // Identity is sorted by name, but numbered files and mount precedence
        // follow the submitted order. Both must match before reusing bytes.
        const layout = selected || sources.some((source) => source.resumable)
          ? await hashBlock(new TextEncoder().encode(JSON.stringify(sources.map((source) => source.path)))) : undefined
        const prior = selected ?? downloads.find((item) => item.gameId === request.expectedGameId && item.layout === layout)
        let project = requestedProject, identity = await projectIdentity(sourceGameId, project)
        // A saved remote recipe already contains the resolved project. Each
        // URL has just been reopened; projectIdentity below pins the versions
        // and project together without downloading XP3/ZIP headers again.
        if (selected && selected.gameId !== identity)
          throw new Error('Game sources changed; reload the game before saving it to the library')
        if (requestedProject && !(prior?.reopenable && identity === prior.gameId)) {
          const reader = createSessionArchiveReader(undefined, encodings.zipEncoding)
          try {
            project = (await prepareProject(await importSources(sources, checkpoint, { lazyArchives: true }),
              { mode: 'root', ...requestedProject }, reader, checkpoint)).project
          } finally { reader.dispose() }
          identity = await projectIdentity(sourceGameId, project)
        }
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
        if (prior && (prior.layout !== layout || prior.gameId !== identity || prior.size !== total))
          throw new Error('保存的下载来源与游戏版本不符。')
        if (prior) { id = prior.id; durable = true }
        const record = validateRecord({
          version: 1,
          id,
          gameId: identity,
          ...encodings,
          ...(project === undefined ? {} : { project, sourceGameId }),
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
          !prior && estimate.quota !== undefined &&
          estimate.usage !== undefined &&
          estimate.quota - estimate.usage <
            total + new TextEncoder().encode(JSON.stringify(record)).length
        )
          throw new DOMException('Not enough browser storage for this game', 'QuotaExceededError')
        if (layout && !prior) {
          if (downloads.length >= MAX_LIBRARY_GAMES) throw new Error('请先移除不再需要的未完成下载。')
          const remote = request.files.flatMap((file) => 'url' in file ? [{ path: file.path, url: remoteUrl(file.url) }] : [])
          const reopenable = remote.length === sources.length
          await this.index.startDownload({ id, gameId: identity, title: settings.title, size: total, layout, reopenable },
            reopenable ? { files: remote, expectedGameId: identity, ...settings, ...encodings, project } : undefined, signal)
          durable = true
        }
        for (const [index, source] of sources.entries()) {
          signal.throwIfAborted()
          report('copying', source.path)
          const saved = durable && source.resumable ? {
            hashes: prior ? await this.index.hashes(id, index, signal) : new Map<number, string>(),
            save: (block: number, hash: string) => this.index.saveHash(id, index, block, hash, signal),
          } : undefined
          record.files[index] = await this.files.write(id, index, source, signal, (bytes, fromDisk) => {
            completed += bytes
            if (fromDisk) reused += bytes
            if (performance.now() - lastReport >= 50 || completed === total)
              report('copying', source.path)
          }, saved)
        }
        const stored = await this.files.sources(id, record.files, readPool, signal)
        if ((await gameIdentity(stored, checkpoint)) !== sourceGameId)
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
        if (!published && !durable) await this.files.remove(id).catch(() => {})
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
          })) !== (record.sourceGameId ?? record.gameId) ||
          (await projectIdentity(record.sourceGameId ?? record.gameId, record.project)) !== record.gameId
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
  async remove(id: string, unfinishedOnly = false): Promise<void> {
    libraryId(id)
    await this.locks.request(LIBRARY_WRITE_LOCK, async () => {
      if (unfinishedOnly && !(await this.index.catalog()).downloads.some((item) => item.id === id))
        throw new Error('这项下载已经完成或已被移除。')
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
    await this.locks.request(LIBRARY_WRITE_LOCK, async () => {
      const record = await this.index.get(id)
      await this.index.put({ ...record, ...gameSettings(settings, record.project) })
    })
  }
}
