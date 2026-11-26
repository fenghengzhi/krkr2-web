// Compare UTF-16 code units without expanding a single character into several.
export function foldDiscName(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!, upper = char.toUpperCase()
    out += upper.length === 1 ? upper : char
  }
  return out
}

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
