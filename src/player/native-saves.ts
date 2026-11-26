import { MAX_SAVE_BYTES, MAX_SAVE_FILES, type SaveFile } from '../engine/ports/saves.ts'
import { validateNativeSavePaths } from '../engine/storage/native-save-paths.ts'
import { BlobSource, inflateRaw } from '../backends/files/blob-source.ts'
import { checkedCrc32 } from '../formats/binary/crc32.ts'
import { readZip } from '../formats/zip/archive.ts'
import { zipNameCodecs } from '../backends/files/zip-names.ts'
import type { ZipNameEncoding } from '../formats/zip/names.ts'

const maxArchive = 96 * 1024 * 1024
type Check = () => Promise<void>
interface SaveEntry { name: string; size: number; read(): Promise<Uint8Array> }

function validateEntries(entries: readonly { name: string; size: number }[]): void {
  if (!entries.length) throw new Error('没有存档文件')
  if (entries.length > MAX_SAVE_FILES) throw new Error('存档文件数量超过限制')
  let total = 0
  for (const { size } of entries) {
    total += size
    if (!Number.isSafeInteger(size) || size < 0 || total > MAX_SAVE_BYTES) throw new Error('存档总量超过 64 MiB')
  }
  validateNativeSavePaths(entries.map((entry) => entry.name))
}

function checkpoint(active: () => void): Check {
  let deadline = performance.now() + 8
  return async () => {
    active()
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      deadline = performance.now() + 8
      active()
    }
  }
}

async function readEntries(entries: SaveEntry[], check: Check): Promise<SaveFile[]> {
  await check()
  validateEntries(entries)
  const result: SaveFile[] = []
  for (const entry of entries) {
    await check()
    result.push({ path: entry.name, bytes: await entry.read() })
  }
  await check()
  return result
}

/** Index only. A desktop backup can contain a large game alongside its saves.
 * The save limits and full member CRCs apply to the selected subtree. */
export async function openNativeSaveZip(file: File, active: () => void, zipEncoding?: ZipNameEncoding) {
  const check = checkpoint(active)
  await check()
  const entries = await readZip(new BlobSource(file), { ...zipNameCodecs(zipEncoding),
    inflate: (bytes, size) => inflateRaw(bytes, size, check), checkpoint: check })
  await check()
  return {
    name: file.name,
    directory(prefix: string) {
      active()
      const children = new Set<string>()
      let count = 0, size = 0
      for (const entry of entries) {
        if (!entry.name.startsWith(prefix)) continue
        count++
        size += entry.size
        const slash = entry.name.indexOf('/', prefix.length)
        if (slash !== -1) children.add(entry.name.slice(0, slash + 1))
      }
      return { children: [...children].sort(), count, size, fits: count > 0 && count <= MAX_SAVE_FILES && size <= MAX_SAVE_BYTES }
    },
    async read(prefix: string) {
      if (prefix && !prefix.endsWith('/')) throw new Error('请选择 ZIP 中的目录')
      const selected = entries.filter((entry) => entry.name.startsWith(prefix)).map((entry) => ({
        name: entry.name.slice(prefix.length), size: entry.size, read: () => entry.read(),
      }))
      return readEntries(selected, check)
    },
  }
}

/** Data-directory-relative files, containing their original bytes. */
export async function readNativeSaves(files: readonly File[], folder: boolean,
  active: () => void = () => {}, zipEncoding?: ZipNameEncoding): Promise<SaveFile[]> {
  const check = checkpoint(active)
  await check()
  if (!folder && files.length === 1 && /\.zip$/i.test(files[0]!.name)) {
    const file = files[0]!
    if (file.size > maxArchive) throw new Error('存档 ZIP 超过大小限制')
    return (await openNativeSaveZip(file, active, zipEncoding)).read('')
  }
  let root: string | undefined
  const entries = files.map((file) => {
    let name = file.name
    if (folder) {
      const path = file.webkitRelativePath, slash = path.indexOf('/')
      if (slash <= 0 || (root !== undefined && path.slice(0, slash) !== root))
        throw new Error('请选择一个完整的存档目录')
      root = path.slice(0, slash)
      name = path.slice(slash + 1)
    }
    return { name, size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) }
  })
  return readEntries(entries, check)
}

/** Single-disk UTF-8 stored ZIP. Slot thumbnails and trailing bookmark data
 * remain one member and the archive can be extracted by desktop utilities. */
export async function writeNativeSaves(files: readonly SaveFile[], active: () => void = () => {}): Promise<Blob> {
  validateEntries(files.map((file) => ({ name: file.path, size: file.bytes.length })))
  active()
  const snapshot = files.map(({ path, bytes }) => ({ path, bytes: Uint8Array.from(bytes) }))
  const check = checkpoint(active), encoder = new TextEncoder()
  const contents: BlobPart[] = [], directory: BlobPart[] = []
  let offset = 0, directoryBytes = 0
  for (const { path, bytes } of snapshot) {
    await check()
    const name = encoder.encode(path)
    const local = new Uint8Array(30 + name.length), header = new DataView(local.buffer)
    header.setUint32(0, 0x04034b50, true)
    header.setUint16(4, 20, true)
    header.setUint16(6, 0x800, true)
    header.setUint16(12, 33, true) // January 1, 1980 in the DOS date field.
    header.setUint32(14, await checkedCrc32(bytes, check), true)
    header.setUint32(18, bytes.length, true)
    header.setUint32(22, bytes.length, true)
    header.setUint16(26, name.length, true)
    local.set(name, 30)
    const central = new Uint8Array(46 + name.length), record = new DataView(central.buffer)
    record.setUint32(0, 0x02014b50, true)
    record.setUint16(4, 20, true)
    central.set(local.subarray(4, 30), 6)
    record.setUint32(42, offset, true)
    central.set(name, 46)
    contents.push(local, bytes)
    directory.push(central)
    offset += local.length + bytes.length
    directoryBytes += central.length
    if (offset + directoryBytes + 22 > maxArchive) throw new Error('存档 ZIP 超过大小限制')
  }
  const end = new Uint8Array(22), trailer = new DataView(end.buffer)
  trailer.setUint32(0, 0x06054b50, true)
  trailer.setUint16(8, snapshot.length, true)
  trailer.setUint16(10, snapshot.length, true)
  trailer.setUint32(12, directoryBytes, true)
  trailer.setUint32(16, offset, true)
  await check()
  return new Blob([...contents, ...directory, end], { type: 'application/zip' })
}
