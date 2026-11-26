/** TVPGetBeingFont: only ASCII commas separate candidates; Trim removes
 * ASCII whitespace/control bytes. An empty candidate forces the following
 * nonempty name without an installed-font check. A leading @ applies to the
 * entire list, rather than only to its first candidate. */
export function* fontCandidates(face: string): Generator<{ name: string; forced: boolean; vertical: boolean }> {
  const vertical = face.startsWith('@')
  let at = vertical ? 1 : 0, forced = false
  while (at < face.length) {
    const comma = face.indexOf(',', at), end = comma < 0 ? face.length : comma,
      name = face.slice(at, end).replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
    if (name) yield { name, forced, vertical }
    forced = !name
    at = end + 1
  }
}
