import { MAX_SAVE_FILES, type SaveFile } from '../engine/ports/saves.ts'
import { normalizeResourcePath } from '../engine/storage/public-path.ts'
import { createSaveDirectory, type SaveDirectoryEntry } from './native-saves.ts'
export function encodeBackup(gameId: string, files: SaveFile[]): Blob {
  const data = files.map(({ path, bytes }) => {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    return { path, base64: btoa(binary) }
  })
  return new Blob(
    [JSON.stringify({ format: 'krkr2-web-saves', version: 1, gameId, files: data })],
    { type: 'application/json' },
  )
}
async function readBackupDocument(blob: Blob, active: () => void = () => {}) {
  if (blob.size > 96 * 1024 * 1024) throw new Error('存档备份超过大小限制')
  active()
  const text = await blob.text()
  active()
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object') throw new Error('无效的存档备份')
  const object = parsed as Record<string, unknown>
  if (object.format !== 'krkr2-web-saves' || object.version !== 1 || !Array.isArray(object.files))
    throw new Error('不支持的存档备份格式')
  return { gameId: object.gameId, files: object.files }
}
function backupEntry(file: unknown): { path: string; base64: string } {
  if (!file || typeof file !== 'object') throw new Error('无效的存档条目')
  const entry = file as Record<string, unknown>
  if (typeof entry.path !== 'string' || typeof entry.base64 !== 'string')
    throw new Error('无效的存档条目')
  return { path: entry.path, base64: entry.base64 }
}
export async function decodeBackup(gameId: string, blob: Blob): Promise<SaveFile[]> {
  const object = await readBackupDocument(blob)
  if (object.gameId !== gameId) throw new Error('这份存档属于另一组游戏文件，请先载入对应游戏')
  if (object.files.length > MAX_SAVE_FILES) throw new Error('存档文件数量超过限制')
  return object.files.map((file: unknown) => {
    const entry = backupEntry(file), binary = atob(entry.base64)
    return { path: entry.path, bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)) }
  })
}

/** Explicit cross-version migration keeps the old identity visible and
 * requires a directory selection. The ordinary import above stays strict. */
export async function openSaveBackup(file: File, active: () => void = () => {}) {
  active()
  const object = await readBackupDocument(file, active)
  active()
  if (typeof object.gameId !== 'string' || !object.gameId) throw new Error('备份缺少来源游戏标识')
  if (object.files.length > MAX_SAVE_FILES) throw new Error('存档文件数量超过限制')
  const entries: SaveDirectoryEntry[] = []
  let deadline = performance.now() + 8
  for (const value of object.files) {
    const entry = backupEntry(value), name = normalizeResourcePath(entry.path)
    if (name.includes('>') || name.length > 4096 || /[\\/]$/.test(entry.path))
      throw new Error('无效的备份文件路径：' + entry.path)
    // atob accepts ordinary whitespace and unpadded Base64. Derive the exact
    // decoded size without allocating every other edition's save bytes.
    const encoded = entry.base64.replace(/[\t\n\f\r ]/g, ''), length = encoded.length,
      padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || length % 4 === 1 || (padding && length % 4 !== 0))
      throw new Error('备份中有无效的文件编码：' + name)
    const size = Math.floor(length * 3 / 4) - padding
    entries.push({ name, size, async read() {
      active()
      const binary = atob(encoded), bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
      active()
      return bytes
    } })
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      active(); deadline = performance.now() + 8
    }
  }
  active()
  return { ...createSaveDirectory(file.name, entries, active), gameId: object.gameId }
}
