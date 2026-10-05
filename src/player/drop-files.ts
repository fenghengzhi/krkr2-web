import { dropLimits, type DropEntry, type DropRoot } from '../engine/ports/storage-drop.ts'
import { dropBasename } from '../engine/storage/drop.ts'
import type { BrowserDropTree } from '../protocol/storage-drop.ts'

interface EntryCapability {
  readonly name: string
  readonly isFile: boolean
  readonly isDirectory: boolean
  file?(success: (file: File) => void, failure?: (error: unknown) => void): void
  createReader?(): { readEntries(success: (entries: EntryCapability[]) => void, failure?: (error: unknown) => void): void }
}
interface HandleCapability {
  readonly name: string
  readonly kind: 'file' | 'directory'
  getFile?(): Promise<File>
  values?(): AsyncIterableIterator<HandleCapability>
}
type HandleOutcome = { handle: HandleCapability | null } | { error: unknown }
interface CapturedItem {
  readonly file?: File
  readonly entry?: EntryCapability
  readonly handle?: Promise<HandleOutcome>
  readonly error?: unknown
}
export interface CapturedDrop { readonly items: readonly CapturedItem[] }

/** This function must run synchronously inside the drop event. Capability
 * acquisition is never deferred until the coordinator eventually dispatches
 * the item. Every started handle promise has a rejection observer immediately. */
export function captureDrop(transfer: DataTransfer): CapturedDrop {
  if ((transfer.items?.length ?? 0) > dropLimits.entries)
    throw new Error('Drop exceeds item metadata budget')
  const items: CapturedItem[] = [], offered = Array.from(transfer.items ?? []).filter((item) => item.kind === 'file')
  if (offered.length > dropLimits.roots) throw new Error('Drop exceeds top-level item budget')
  for (const item of offered) {
    let file: File | undefined, entry: EntryCapability | undefined, error: unknown,
      handle: Promise<HandleOutcome> | undefined
    try { file = item.getAsFile() ?? undefined } catch (cause) { error = cause }
    const capable = item as unknown as {
      webkitGetAsEntry?(): EntryCapability | null
      getAsFileSystemHandle?(): Promise<HandleCapability | null>
    }
    try { entry = capable.webkitGetAsEntry?.() ?? undefined } catch (cause) { error ??= cause }
    try {
      if (capable.getAsFileSystemHandle) {
        // Calling the browser method now is essential; awaiting happens later.
        const pending = capable.getAsFileSystemHandle()
        handle = Promise.resolve(pending).then((value): HandleOutcome => ({ handle: value }),
          (cause): HandleOutcome => ({ error: cause }))
      }
    } catch (cause) { error ??= cause }
    if (!file && !entry && !handle) throw error ?? new Error('Browser did not provide the dropped file or directory capability')
    items.push(Object.freeze({ file, entry, handle, error }))
  }
  if (!offered.length) {
    if ((transfer.files?.length ?? 0) > dropLimits.roots) throw new Error('Drop exceeds top-level item budget')
    const files = Array.from(transfer.files ?? [])
    if (files.length > dropLimits.roots) throw new Error('Drop exceeds top-level item budget')
    for (const file of files) items.push(Object.freeze({ file }))
    if (!files.length && Array.from(transfer.types ?? []).includes('Files'))
      throw new Error('Browser cannot expose this dropped file or directory')
  }
  return Object.freeze({ items: Object.freeze(items) })
}

/** Enumerates captured native capabilities without reading file payloads.
 * These API reads are cancelable waits, not a claim that the browser's pending
 * directory/getFile operation itself can be forcibly canceled. */
export async function enumerateDrop(captured: CapturedDrop,
  options: { signal: AbortSignal; checkpoint?: () => void | Promise<void> }): Promise<BrowserDropTree> {
  const { signal } = options
  const check = () => { signal.throwIfAborted() }
  const wait = <T>(work: PromiseLike<T>): Promise<T> => {
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      void Promise.resolve(work).then((value) => { signal.removeEventListener('abort', abort); resolve(value) },
        (error) => { signal.removeEventListener('abort', abort); reject(error) })
      if (signal.aborted) abort()
    })
  }
  const roots: DropRoot[] = [], entries: DropEntry<Blob>[] = [], names = new Set<string>()
  let units = 0, bytes = 0, nextYield = performance.now() + 8
  const step = async () => {
    check()
    if (!(entries.length % 128) || performance.now() >= nextYield) {
      await wait(new Promise<void>((resolve) => setTimeout(resolve, 0)))
      nextYield = performance.now() + 8
    }
    if (options.checkpoint) await wait(Promise.resolve(options.checkpoint()))
    check()
  }
  const add = (root: number, path: string, kind: 'file' | 'directory', file?: File) => {
    check()
    if (path.length > dropLimits.pathUnits || (path && path.split('/').length > dropLimits.depth))
      throw new Error('Dropped directory exceeds path or depth budget')
    const key = root + ':' + path
    if (names.has(key)) throw new Error('Browser returned a duplicate directory entry')
    names.add(key); units += path.length
    if (entries.length >= dropLimits.entries || units > dropLimits.batchNameUnits)
      throw new Error('Dropped tree exceeds entry or name budget')
    if (kind === 'file') {
      if (!(file instanceof File)) throw new Error('Dropped file capability is unavailable')
      bytes += file.size
      if (!Number.isSafeInteger(bytes) || bytes > dropLimits.sourceBytes) throw new Error('Dropped tree exceeds source-size budget')
      entries.push({ root, path, kind, source: file })
    } else entries.push({ root, path, kind })
  }
  const fileFromEntry = (entry: EntryCapability) => wait(new Promise<File>((resolve, reject) => {
    if (!entry.file) { reject(new Error('Browser directory entry cannot provide its file')); return }
    entry.file(resolve, reject)
  }))
  const visitEntry = async (entry: EntryCapability, root: number, path: string, capturedFile?: File): Promise<void> => {
    if (!entry || entry.isFile === entry.isDirectory) throw new Error('Invalid browser directory entry')
    dropBasename(entry.name)
    if (entry.isFile) {
      const file = capturedFile ?? await fileFromEntry(entry)
      check()
      if (file.name !== entry.name) throw new Error('Dropped file name changed during enumeration')
      add(root, path, 'file', file)
    } else {
      add(root, path, 'directory')
      const reader = entry.createReader?.()
      if (!reader) throw new Error('Browser cannot enumerate the dropped directory')
      for (;;) {
        await step()
        const children = await wait(new Promise<EntryCapability[]>((resolve, reject) => reader.readEntries(resolve, reject)))
        if (!Array.isArray(children)) throw new Error('Browser returned invalid directory entries')
        if (!children.length) break
        if (children.length > dropLimits.entries - entries.length) throw new Error('Dropped directory exceeds entry budget')
        for (const child of children) {
          const name = dropBasename(child?.name)
          await visitEntry(child, root, path ? path + '/' + name : name)
        }
      }
    }
    await step()
  }
  const visitHandle = async (handle: HandleCapability, root: number, path: string): Promise<void> => {
    dropBasename(handle?.name)
    if (handle.kind === 'file') {
      if (!handle.getFile) throw new Error('Browser file handle cannot provide its file')
      const file = await wait(handle.getFile())
      check()
      if (file.name !== handle.name) throw new Error('Dropped file name changed during enumeration')
      add(root, path, 'file', file)
    } else if (handle.kind === 'directory') {
      add(root, path, 'directory')
      const iterator = handle.values?.()
      if (!iterator) throw new Error('Browser cannot enumerate the dropped directory handle')
      // A pending native next() can outlive cancellation. Do not await an
      // iterator.return() behind that pending native operation during Stop.
      for (;;) {
        await step()
        const next = await wait(iterator.next())
        if (next.done) break
        const child = next.value, name = dropBasename(child?.name)
        await visitHandle(child, root, path ? path + '/' + name : name)
      }
    } else throw new Error('Invalid dropped filesystem handle')
    await step()
  }
  check()
  if (!captured || !Array.isArray(captured.items) || captured.items.length > dropLimits.roots)
    throw new Error('Invalid captured drop')
  for (const [root, item] of captured.items.entries()) {
    check()
    let handle: HandleCapability | undefined, handleError: unknown
    if (!item.entry && item.handle) {
      const result = await wait(item.handle)
      if ('error' in result) handleError = result.error
      else handle = result.handle ?? undefined
    }
    if (!item.entry && !handle && !item.file)
      throw handleError ?? item.error ?? new Error('Dropped capability is unavailable')
    const kind = item.entry ? item.entry.isDirectory ? 'directory' : 'file' : handle?.kind ?? 'file',
      name = dropBasename(item.entry?.name ?? handle?.name ?? item.file?.name)
    units += name.length
    if (units > dropLimits.batchNameUnits) throw new Error('Dropped tree exceeds name budget')
    roots.push({ name, kind })
    if (item.entry) await visitEntry(item.entry, root, '', item.entry.isFile ? item.file : undefined)
    else if (handle) await visitHandle(handle, root, '')
    else if (item.file) add(root, '', 'file', item.file)
    else throw handleError ?? item.error ?? new Error('Dropped capability is unavailable')
  }
  check()
  return { roots, entries }
}
