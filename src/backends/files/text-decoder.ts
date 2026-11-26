import { dosNameDecoder, type LegacyNameEncoding } from '../../formats/text/legacy-names.ts'
import koreanIndex from '../../formats/text/euc-kr-index.json' with { type: 'json' }

/** WHATWG EUC-KR includes the Windows-949 Hangul extension. Host ICU's
 * traditional EUC-KR converter can instead return a control and an ASCII
 * letter for the same pair. Use the standard index for consistent filenames,
 * CUE references and story text. The WHATWG index (2024-09-18) is grouped by
 * pointer / 190. Each row starts at trail byte 0x41, with spaces for unmapped
 * pointers and trailing gaps omitted. See public/licenses/whatwg-encoding.txt. */
function decodeKorean(bytes: Uint8Array): string {
  const chunks: string[] = [], buffer = new Uint16Array(Math.min(bytes.length, 4096))
  let used = 0
  for (let i = 0; i < bytes.length; i++) {
    let code = bytes[i]!
    if (code >= 0x80) {
      const row = koreanIndex[code - 0x81], trail = bytes[++i]
      if (!row || trail === undefined || trail < 0x41 || trail - 0x41 >= row.length)
        throw new TypeError('Invalid Windows-949 text')
      code = row.charCodeAt(trail - 0x41)
      if (code === 0x20) throw new TypeError('Unassigned Windows-949 character')
    }
    buffer[used++] = code
    if (used === buffer.length) { chunks.push(String.fromCharCode(...buffer)); used = 0 }
  }
  if (used) chunks.push(String.fromCharCode(...buffer.subarray(0, used)))
  return chunks.join('')
}

const koreanDecoder = { decode: decodeKorean }

export function strictTextDecoder(label: string, ignoreBOM = false): { decode(bytes: Uint8Array): string } {
  if (label === 'euc-kr') return koreanDecoder
  const decoder = new TextDecoder(label, { fatal: true, ignoreBOM })
  return decoder.encoding === 'euc-kr' ? koreanDecoder : decoder
}

export function legacyNameDecoder(encoding: LegacyNameEncoding): (bytes: Uint8Array) => string {
  const dos = dosNameDecoder(encoding)
  if (dos) return dos
  const decoder = strictTextDecoder(encoding, true)
  return (bytes) => decoder.decode(bytes)
}
