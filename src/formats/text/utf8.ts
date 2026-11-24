/** Strict UTF-8, independent of DOM codecs. Preserves a leading BOM as a character. */
export function* decodeUtf8(bytes: Uint8Array, invalid: () => Error): Generator<void, string> {
  let value = ''
  for (let at = 0, work = 0; at < bytes.length;) {
    const first = bytes[at++]!
    let point = first,
      extra = 0,
      min = 0
    if (first >= 0xc2 && first <= 0xdf) {
      extra = 1
      point &= 31
      min = 0x80
    } else if (first >= 0xe0 && first <= 0xef) {
      extra = 2
      point &= 15
      min = 0x800
    } else if (first >= 0xf0 && first <= 0xf4) {
      extra = 3
      point &= 7
      min = 0x10000
    } else if (first >= 0x80) throw invalid()
    for (let i = 0; i < extra; i++) {
      const next = bytes[at++]
      if (next === undefined || (next & 0xc0) !== 0x80) throw invalid()
      point = point * 64 + (next & 63)
    }
    if (point < min || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
      throw invalid()
    value += String.fromCodePoint(point)
    if (++work >= 4096) {
      work = 0
      yield
    }
  }
  return value
}
