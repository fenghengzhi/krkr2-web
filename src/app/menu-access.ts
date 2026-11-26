/** MenuItemImpl passes captions verbatim to VCL (AutoHotkeys = maManual).
 * A single & marks an access key, && is a literal &, and text after a tab is
 * the separate shortcut hint. Japanese KAG captions commonly use (&S). */
export function menuAccessKey(caption: string): string | undefined {
  const end = caption.indexOf('\t'), text = end < 0 ? caption : caption.slice(0, end)
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '&') continue
    if (text[i + 1] === '&') { i++; continue }
    return text[i + 1]!.toLowerCase()
  }
}

/** Duplicate keys select the next matching item; Enter then activates it.
 * Callers supply the current level's visible, enabled items in menu order. */
export function menuAccessMatch(captions: readonly string[], key: string, current = -1): { index: number; unique: boolean } | undefined {
  const matches: number[] = []
  for (let i = 0; i < captions.length; i++) if (menuAccessKey(captions[i]!) === key.toLowerCase()) matches.push(i)
  if (!matches.length) return
  return { index: matches.find((index) => index > current) ?? matches[0]!, unique: matches.length === 1 }
}
