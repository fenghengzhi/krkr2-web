import type { ByteSource } from '../../engine/ports/storage.ts'
import type { VideoSourceControl } from '../../engine/ports/video.ts'
import { ExecutionCancelled } from '../../engine/scheduler/control.ts'
import type { LibraryWriter } from './opfs-library.ts'

export const temporaryMovieDirectory = 'krkr2-web-temporary-movies-v1'
const generatedName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const lockName = (name: string) => temporaryMovieDirectory + '/' + name
type MovieFile = Omit<FileSystemFileHandle, 'createSyncAccessHandle'> & { createSyncAccessHandle(): Promise<LibraryWriter> }

async function remove(directory: FileSystemDirectoryHandle, name: string) {
  try { await directory.removeEntry(name) }
  catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error }
}

async function openDirectory() {
  if (!globalThis.navigator?.storage?.getDirectory || !navigator.locks)
    throw new Error('Large range-backed movies require browser file storage and Web Locks')
  const root = await navigator.storage.getDirectory()
  const directory = await root.getDirectoryHandle(temporaryMovieDirectory, { create: true })
  // A terminated game worker releases its Web Locks. Another tab may still
  // be playing or writing a different movie in this same origin.
  for await (const name of (directory as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) {
    if (generatedName.test(name))
      await navigator.locks.request(lockName(name), { ifAvailable: true }, async (lock) => {
        if (lock) await remove(directory, name)
      })
  }
  return directory
}

async function copyMovie(source: ByteSource, size: number, writer: LibraryWriter, control: VideoSourceControl, check: () => void) {
  for (let offset = 0; offset < size;) {
    await control.checkpoint()
    check()
    const length = Math.min(1024 * 1024, size - offset)
    const bytes = await source.read(offset, length)
    check()
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('Video resource returned an invalid range')
    for (let at = 0; at < length;) {
      const count = writer.write(bytes.subarray(at), { at: offset + at })
      if (!Number.isSafeInteger(count) || count <= 0 || count > length - at) throw new Error('Incomplete temporary movie write')
      at += count
      if (at < length) { await control.checkpoint(); check() }
    }
    offset += length
  }
}

export class TemporaryMovieFiles {
  private directory?: Promise<FileSystemDirectoryHandle>
  private readonly active = new Map<() => void, Promise<void>>()
  private closed = false
  private cleanupError?: unknown

  async stage(source: ByteSource, control: VideoSourceControl, signal: AbortSignal): Promise<{ blob: File; release(): Promise<void> }> {
    if (this.closed) throw new ExecutionCancelled()
    const size = source.size
    this.directory ??= openDirectory().catch((error) => { this.directory = undefined; throw error })
    const directory = await this.directory
    control.check()
    signal.throwIfAborted()
    if (this.closed) throw new ExecutionCancelled()
    const name = crypto.randomUUID()
    let end!: () => void, ended = false
    const lifetime = new Promise<void>((resolve) => { end = resolve })
    const release = () => { ended = true; end() }
    const check = () => { if (ended) throw new ExecutionCancelled(); control.check() }
    let publish!: (file: File) => void, fail!: (error: unknown) => void
    const ready = new Promise<File>((resolve, reject) => { publish = resolve; fail = reject })
    signal.addEventListener('abort', release, { once: true })
    const work = navigator.locks.request(lockName(name), async () => {
      check()
      const handle = await directory.getFileHandle(name, { create: true }) as MovieFile
      try {
        if (!handle.createSyncAccessHandle) throw new Error('Large range-backed movies require writable browser file storage in the game worker')
        const writer = await handle.createSyncAccessHandle()
        try {
          // A provider can still be waiting on network IO when the game exits.
          // Its continuation checks ended before touching the closed writer.
          await Promise.race([copyMovie(source, size, writer, control, check), lifetime])
          check()
          writer.flush()
          if (writer.getSize() !== size) throw new Error('Temporary movie size mismatch')
        } finally { writer.close() }
        const file = await handle.getFile()
        check()
        if (file.size !== size || size !== source.size) throw new Error('Temporary movie source size changed')
        signal.removeEventListener('abort', release)
        publish(file)
        await lifetime
      } finally {
        try { await remove(directory, name) }
        catch (error) { this.cleanupError ??= error; throw error }
      }
    }).catch(fail).finally(() => {
      signal.removeEventListener('abort', release)
      this.active.delete(release)
    })
    this.active.set(release, work)
    return { blob: await ready, release() { release(); return work } }
  }

  async close() {
    this.closed = true
    const pending = [...this.active.values()]
    for (const release of this.active.keys()) release()
    await Promise.all(pending)
    if (this.cleanupError) throw this.cleanupError
  }
}
