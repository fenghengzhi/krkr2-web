import { zipNameEncoding, type ZipNameEncoding } from '../../formats/zip/names.ts'
import { legacyNameDecoder } from './text-decoder.ts'

export function zipNameCodecs(encoding?: ZipNameEncoding) {
  const name = zipNameEncoding(encoding)
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const decode = name === 'utf-8' ? (bytes: Uint8Array) => utf8.decode(bytes) : legacyNameDecoder(name)
  return {
    utf8: (bytes: Uint8Array) => utf8.decode(bytes),
    legacyName: (bytes: Uint8Array) => {
      try { return decode(bytes) }
      catch (cause) { throw new Error(`ZIP 文件名无法按 ${name} 解码`, { cause }) }
    },
  }
}
