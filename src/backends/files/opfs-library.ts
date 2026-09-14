import { MAX_RESOURCE_BYTES, type ByteSource } from '../../engine/ports/storage.ts'
import type { SourceFile } from './source-files.ts'
import {
  LIBRARY_BLOCK_BYTES as BLOCK,
  LIBRARY_DIRECTORY,
  libraryId,
  type LibraryFile,
} from '../../player/library/records.ts'

export interface LibraryWriter {
  write(bytes: Uint8Array, options: { at: number }): number
  truncate(size: number): void
  getSize(): number
  flush(): void
  close(): void
}
type SyncFile = Omit<FileSystemFileHandle, 'createSyncAccessHandle'> & {
  createSyncAccessHandle(): Promise<LibraryWriter>
}
export const hashBlock = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/** A bounded copy; partial writes and failure to flush are errors, never a published file. */
export async function copyLibraryFile(
  source: SourceFile,
  writer: LibraryWriter,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<LibraryFile> {
  const hashes: string[] = []
  let deadline = performance.now() + 8
  try {
    signal.throwIfAborted()
    writer.truncate(0)
    for (let offset = 0; offset < source.source.size; offset += BLOCK) {
      signal.throwIfAborted()
      const length = Math.min(BLOCK, source.source.size - offset)
      const bytes = await source.source.read(offset, length)
      signal.throwIfAborted()
      if (bytes.length !== length) throw new Error('Source file changed during library import')
      hashes.push(await hashBlock(bytes))
      signal.throwIfAborted()
      for (let at = 0; at < bytes.length;) {
        const count = writer.write(bytes.subarray(at), { at: offset + at })
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - at)
          throw new Error('Incomplete OPFS write')
        at += count
        if (performance.now() >= deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          deadline = performance.now() + 8
        }
        signal.throwIfAborted()
      }
      progress(length)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    signal.throwIfAborted()
    writer.flush()
    if (writer.getSize() !== source.source.size)
      throw new Error('OPFS file size mismatch after writing')
    return {
      path: source.path,
      size: source.source.size,
      hashes,
      ...(source.remoteIdentity === undefined ? {} : { remoteIdentity: source.remoteIdentity }),
    }
  } finally {
    writer.close()
  }
}

/** Immutable verified blocks share a 32 MiB LRU across every file opened by a game. */
export class OpfsReadPool {
  private readonly abort = new AbortController()
  private readonly cache = new Map<string, Uint8Array>()
  private readonly pending = new Map<string, Promise<Uint8Array>>()
  private retained = 0
  private reading = 0
  private error?: unknown
  private closed = false
  constructor(
    private readonly signal: AbortSignal,
    private readonly limit = 32 * BLOCK,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_RESOURCE_BYTES)
      throw new Error('Invalid OPFS cache budget')
    signal.addEventListener('abort', this.close, { once: true })
    if (signal.aborted) this.close()
  }
  private check(): void {
    this.signal.throwIfAborted()
    if (this.closed) throw new Error('Library sources are closed')
    if (this.error) throw this.error
  }
  close = (): void => {
    this.closed = true
    if (!this.abort.signal.aborted)
      this.abort.abort(
        this.signal.aborted
          ? this.signal.reason
          : new DOMException('Library sources closed', 'AbortError'),
      )
    this.cache.clear()
    this.retained = 0
    this.pending.clear()
    this.signal.removeEventListener('abort', this.close)
  }
  inspect() {
    return {
      cacheBytes: this.retained,
      pendingBlocks: this.pending.size,
      pendingReadBytes: this.reading,
    }
  }
  private async interruptible<T>(promise: Promise<T>): Promise<T> {
    const signal = this.abort.signal
    let cancel = () => {}
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
    try {
      return await Promise.race([promise, aborted])
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }
  source(key: string, blob: Blob, record: LibraryFile): ByteSource {
    this.check()
    if (blob.size !== record.size) throw new Error(`Library file is incomplete: ${record.path}`)
    return {
      size: record.size,
      read: async (offset, length) => {
        this.check()
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 0 ||
          offset > record.size ||
          length > record.size - offset ||
          length > MAX_RESOURCE_BYTES
        )
          throw new Error('Library read exceeds bounds or 64 MiB budget')
        if (this.reading + length > MAX_RESOURCE_BYTES * 2)
          throw new Error('Library pending reads exceed 128 MiB budget')
        this.reading += length
        try {
          const result = new Uint8Array(length)
          for (let cursor = offset; cursor < offset + length;) {
            const block = Math.floor(cursor / BLOCK),
              start = cursor % BLOCK
            const data = await this.block(`${key}:${block}`, blob, block, record)
            this.check()
            const count = Math.min(data.length - start, offset + length - cursor)
            result.set(data.subarray(start, start + count), cursor - offset)
            cursor += count
          }
          this.check()
          return result
        } finally {
          this.reading -= length
        }
      },
    }
  }
  private block(key: string, blob: Blob, block: number, record: LibraryFile): Promise<Uint8Array> {
    this.check()
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      return Promise.resolve(cached)
    }
    const existing = this.pending.get(key)
    if (existing) return existing
    if (this.pending.size >= 64) throw new Error('OPFS read queue exceeds 64 blocks')
    const promise = (async () => {
      const start = block * BLOCK,
        length = Math.min(BLOCK, record.size - start)
      const bytes = new Uint8Array(
        await this.interruptible(blob.slice(start, start + length).arrayBuffer()),
      )
      this.check()
      if (
        bytes.length !== length ||
        (await this.interruptible(hashBlock(bytes))) !== record.hashes[block]
      )
        throw new Error(`Library file checksum mismatch: ${record.path}; import the game again`)
      this.check()
      if (bytes.length <= this.limit) {
        while (this.retained + bytes.length > this.limit) {
          const oldest = this.cache.keys().next().value!
          this.retained -= this.cache.get(oldest)!.length
          this.cache.delete(oldest)
        }
        this.cache.set(key, bytes)
        this.retained += bytes.length
      }
      return bytes
    })()
      .catch((error) => {
        this.error = error
        this.cache.clear()
        this.retained = 0
        throw error
      })
      .finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key)
      })
    this.pending.set(key, promise)
    return promise
  }
}

export class OpfsLibraryFiles {
  constructor(private readonly root: FileSystemDirectoryHandle) {}
  static async open(): Promise<OpfsLibraryFiles> {
    const root = await navigator.storage.getDirectory()
    return new OpfsLibraryFiles(await root.getDirectoryHandle(LIBRARY_DIRECTORY, { create: true }))
  }
  async write(
    id: string,
    index: number,
    source: SourceFile,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ): Promise<LibraryFile> {
    signal.throwIfAborted()
    const directory = await this.root.getDirectoryHandle(libraryId(id), { create: true })
    signal.throwIfAborted()
    const file = (await directory.getFileHandle(String(index), { create: true })) as SyncFile
    signal.throwIfAborted()
    const writer = await file.createSyncAccessHandle()
    return copyLibraryFile(source, writer, signal, progress)
  }
  async sources(
    id: string,
    records: LibraryFile[],
    pool: OpfsReadPool,
    signal: AbortSignal,
  ): Promise<SourceFile[]> {
    signal.throwIfAborted()
    const directory = await this.root.getDirectoryHandle(libraryId(id))
    const sources: SourceFile[] = []
    for (const [index, record] of records.entries()) {
      signal.throwIfAborted()
      const file = await (await directory.getFileHandle(String(index))).getFile()
      signal.throwIfAborted()
      sources.push({
        path: record.path,
        source: pool.source(String(index), file, record),
        ...(record.remoteIdentity === undefined ? {} : { remoteIdentity: record.remoteIdentity }),
      })
    }
    return sources
  }
  async remove(id: string): Promise<void> {
    try {
      await this.root.removeEntry(libraryId(id), { recursive: true })
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
    }
  }
  async recover(published: Set<string>): Promise<void> {
    // Only our generated entry directories are candidates, under our private namespace.
    const directory = this.root as FileSystemDirectoryHandle & {
      keys(): AsyncIterableIterator<string>
    }
    for await (const name of directory.keys()) {
      try {
        libraryId(name)
      } catch {
        continue
      }
      if (!published.has(name)) await this.remove(name)
    }
  }
}
