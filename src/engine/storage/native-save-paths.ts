import { normalizeResourcePath } from './public-path.ts'

/** A portable Windows save directory cannot contain two case variants of one
 * file, or a file where another path requires a directory. Check affected
 * paths so older, unrelated overlay entries can still be used. */
export function validateNativeSavePaths(paths: Iterable<string>, existing: Iterable<string> = []): void {
  const incoming = new Set<string>()
  for (const name of paths) {
    if (name.length > 4096 || name.includes('>') || normalizeResourcePath(name) !== name)
      throw new Error('无效的相对存档路径：' + name)
    const key = name.toLowerCase()
    if (incoming.has(key)) throw new Error('存档路径重复：' + name)
    incoming.add(key)
  }
  const files = new Set(incoming)
  for (const name of existing) files.add(name.toLowerCase())
  // Sorting with a separator makes descendants contiguous even when names
  // like "page-1" sort between "page" and "page/1" in a plain file list.
  const ordered = [...files].map((name) => name + '/').sort()
  for (let i = 0; i < ordered.length; i++) {
    const prefix = ordered[i]!, name = prefix.slice(0, -1)
    if (!incoming.has(name)) continue
    if (ordered[i + 1]?.startsWith(prefix)) throw new Error('存档文件与目录同名：' + name)
    for (let slash = name.indexOf('/'); slash >= 0; slash = name.indexOf('/', slash + 1))
      if (files.has(name.slice(0, slash))) throw new Error('存档文件与目录同名：' + name.slice(0, slash))
  }
}
