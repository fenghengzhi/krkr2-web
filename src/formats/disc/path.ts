export { foldWindowsName as foldDiscName } from '../text/windows-name.ts'

export function discPathParts(path: string): string[] {
  if (path.length > 32768 || /^[\\/]/.test(path) || /[\0:]/.test(path)) throw new Error('Expected a relative disc path')
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) throw new Error('Path leaves the disc root'); parts.pop() }
    else parts.push(part)
    if (parts.length > 256) throw new Error('Disc directory depth exceeds 256')
  }
  return parts
}
