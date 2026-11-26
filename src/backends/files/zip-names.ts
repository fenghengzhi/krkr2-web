import { cp437, zipNameEncoding, type ZipNameEncoding } from '../../formats/zip/names.ts'
import { strictTextDecoder } from './text-decoder.ts'

export function zipNameCodecs(encoding?: ZipNameEncoding) {
  const name = zipNameEncoding(encoding)
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const decoder = name === 'cp437' ? undefined : name === 'utf-8' ? utf8 : strictTextDecoder(name, true)
  return {
    utf8: (bytes: Uint8Array) => utf8.decode(bytes),
    legacyName: (bytes: Uint8Array) => {
      if (!decoder) return cp437(bytes)
      try { return decoder.decode(bytes) }
      catch (cause) { throw new Error(`ZIP 文件名无法按 ${name} 解码`, { cause }) }
    },
  }
}
