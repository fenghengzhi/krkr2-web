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

/** Keep the actual requested faces first. When the platform lacks MS PMincho,
 * preserve its documented proportional Mincho/serif class instead of forcing
 * sans-serif. This is a fallback category, not Windows glyph/metric emulation.
 * https://learn.microsoft.com/en-us/typography/font-list/ms-pmincho */
export function cssFontStack(name: string): string {
  const faces = name.split(','), primary = faces[0]!.trim().replace(/^@/, '').toLowerCase(),
    fallback = primary === 'ms pmincho' ? 'serif' : 'sans-serif'
  return faces.map(cssFontFamily).join(',') + ',' + fallback
}
