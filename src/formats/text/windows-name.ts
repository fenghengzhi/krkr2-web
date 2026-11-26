// Compare UTF-16 code units without expanding a single character into several.
export function foldWindowsName(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!, upper = char.toUpperCase()
    out += upper.length === 1 ? upper : char
  }
  return out
}
