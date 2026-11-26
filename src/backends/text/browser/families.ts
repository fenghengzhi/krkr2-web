import { fontFamilyNames, minchoFamily } from '../../../engine/graphics/font-family.ts'

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
  const plain = trimFamily(name).replace(/^@/, '')
  return generic.has(plain.toLowerCase()) ? plain.toLowerCase() : JSON.stringify(plain)
}
const trimFamily = (name: string): string => name.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
export function isGenericFontFamily(name: string): boolean {
  return generic.has(name.toLowerCase())
}

/** Keep every requested family identity ahead of substitutes. Missing MS PMincho uses a
 * named proportional serif family before the browser's platform-dependent
 * generic serif. Liberation Serif is a Times New Roman metric replacement;
 * neither is a reproduction of MS PMincho's Japanese glyphs or exact metrics.
 * https://learn.microsoft.com/en-us/typography/font-list/ms-pmincho
 * https://github.com/liberationfonts/liberation-fonts */
export function cssFontStack(name: string): string {
  const faces = name.split(',').map(trimFamily), primary = minchoFamily(faces[0]!),
    fallback = primary === 'proportional'
      ? '"Times New Roman","Liberation Serif","Times",serif'
      : primary === 'fixed' ? 'serif' : 'sans-serif'
  return faces.flatMap(fontFamilyNames).map(cssFontFamily).join(',') + ',' + fallback
}
