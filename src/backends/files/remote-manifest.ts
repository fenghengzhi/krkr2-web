import { normalizePath } from '../../engine/storage/resolver.ts'
import type { RemoteGameFile } from '../../protocol/session.ts'
import { HttpRangePool, remoteUrl } from './http-range.ts'

// The library accepts up to 10,000 original paths and 8 MiB of metadata.
const maximumManifestBytes = 8 * 1024 * 1024

export function parseRemoteManifest(bytes: Uint8Array, finalUrl: string): RemoteGameFile[] {
  if (bytes.length > maximumManifestBytes) throw new Error('远程游戏清单超过 8 MiB')
  let document: unknown
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('远程游戏清单必须是 UTF-8 JSON') }
  if (!document || typeof document !== 'object' || !('version' in document) || document.version !== 1 ||
      !('files' in document) || !Array.isArray(document.files) || !document.files.length || document.files.length > 10000)
    throw new Error('远程游戏清单需要 version 1 和包含 1 至 10000 个文件的 files 列表')

  const base = remoteUrl(finalUrl), paths = new Set<string>(), encoder = new TextEncoder()
  let descriptorBytes = 0
  return document.files.map((entry: unknown, index: number) => {
    const item = typeof entry === 'string' ? { path: entry } : entry
    if (!item || typeof item !== 'object' || !('path' in item) || typeof item.path !== 'string' ||
        !item.path || item.path.length > 1024 || /(?:^|[\\/])\.{0,2}$/.test(item.path))
      throw new Error(`远程游戏清单第 ${index + 1} 项需要相对文件路径`)
    const path = normalizePath(item.path)
    if (path.includes('>')) throw new Error('清单文件名不能包含 >')
    if (paths.has(path)) throw new Error('远程游戏清单包含重复路径：' + path)
    paths.add(path)
    // The shorthand is a literal game filename. Characters such as #, % and
    // ? acquire URL semantics only when the author explicitly supplies a URL.
    const address = 'url' in item ? item.url : path.split('/').map(encodeURIComponent).join('/')
    if (typeof address !== 'string' || !address.trim()) throw new Error('清单中的文件链接无效：' + path)
    const url = remoteUrl(new URL(address, base).href)
    // Relative entries may all expand a long redirect prefix. Bound the
    // actual descriptor list which the Worker will send back to the page.
    descriptorBytes += encoder.encode(path).byteLength + url.length
    if (descriptorBytes > maximumManifestBytes) throw new Error('远程游戏清单展开后的路径和链接超过 8 MiB')
    return { path, url }
  })
}

export async function readRemoteManifest(input: string, pool: HttpRangePool): Promise<RemoteGameFile[]> {
  const url = remoteUrl(input)
  return pool.request(url, { Accept: 'application/json' }, undefined, async (response, signal) => {
    if (response.status !== 200) throw new Error(`读取远程游戏清单失败（HTTP ${response.status}）`)
    const bytes = await pool.body(response, signal, maximumManifestBytes)
    signal.throwIfAborted()
    return parseRemoteManifest(bytes, response.url || url)
  })
}
