import type { SaveFile } from '../engine/ports/saves.ts'
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
export async function decodeBackup(gameId: string, blob: Blob): Promise<SaveFile[]> {
  if (blob.size > 96 * 1024 * 1024) throw new Error('存档备份超过大小限制')
  const parsed: unknown = JSON.parse(await blob.text())
  if (!parsed || typeof parsed !== 'object') throw new Error('无效的存档备份')
  const object = parsed as Record<string, unknown>
  if (object.format !== 'krkr2-web-saves' || object.version !== 1 || !Array.isArray(object.files))
    throw new Error('不支持的存档备份格式')
  if (object.gameId !== gameId) throw new Error('这份存档属于另一组游戏文件，请先载入对应游戏')
  if (object.files.length > 10000) throw new Error('存档文件数量超过限制')
  return object.files.map((file: unknown) => {
    if (!file || typeof file !== 'object') throw new Error('无效的存档条目')
    const entry = file as Record<string, unknown>
    if (typeof entry.path !== 'string' || typeof entry.base64 !== 'string')
      throw new Error('无效的存档条目')
    const binary = atob(entry.base64)
    return { path: entry.path, bytes: Uint8Array.from(binary, (char) => char.charCodeAt(0)) }
  })
}
