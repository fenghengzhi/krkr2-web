const generic = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
])
export function cssFontFamily(name: string): string {
  const plain = name.trim().replace(/^@/, '')
  return generic.has(plain.toLowerCase()) ? plain.toLowerCase() : JSON.stringify(plain)
}

/** Keep every requested face ahead of substitutes. Missing MS PMincho uses a
 * named proportional serif family before the browser's platform-dependent
 * generic serif. Liberation Serif is a Times New Roman metric replacement;
 * neither is a reproduction of MS PMincho's Japanese glyphs or exact metrics.
 * https://learn.microsoft.com/en-us/typography/font-list/ms-pmincho
 * https://github.com/liberationfonts/liberation-fonts */
export function cssFontStack(name: string): string {
  const faces = name.split(','), primary = faces[0]!.trim().replace(/^@/, '').toLowerCase(),
    fallback = primary === 'ms pmincho'
      ? '"Times New Roman","Liberation Serif","Times",serif'
      : 'sans-serif'
  return faces.map(cssFontFamily).join(',') + ',' + fallback
}
