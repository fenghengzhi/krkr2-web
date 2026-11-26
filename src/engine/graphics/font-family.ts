/** The English and Japanese family names refer to the same Windows faces.
 * The GDI mapper accepts either language, independent of the system locale:
 * https://learn.microsoft.com/en-us/windows/win32/gdi/font-creation-and-selection
 * Keep this small identity table separate from platform substitute fonts. */
const minchoNames = [
  ['MS PMincho', 'ＭＳ Ｐ明朝'],
  ['MS Mincho', 'ＭＳ 明朝'],
] as const

export function minchoFamily(name: string): 'proportional' | 'fixed' | undefined {
  const plain = name.replace(/^@/, '').toLowerCase()
  const index = minchoNames.findIndex((names) => names.some((value) => value.toLowerCase() === plain))
  return index === 0 ? 'proportional' : index === 1 ? 'fixed' : undefined
}

/** Exact spelling first; the counterpart is a family identity, not a fallback
 * to another design. Preserve a vertical request and unrelated family names. */
export function fontFamilyNames(name: string): readonly string[] {
  const vertical = name.startsWith('@'), plain = (vertical ? name.slice(1) : name).toLowerCase()
  const names = minchoNames.find((pair) => pair.some((value) => value.toLowerCase() === plain))
  if (!names) return [name]
  return [name, ...names.filter((value) => value.toLowerCase() !== plain).map((value) => (vertical ? '@' : '') + value)]
}
