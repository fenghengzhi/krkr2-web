import {
  decodeTextStream,
  encodeTextStream,
  modeOffset,
  type TextCodecs,
} from '../../formats/text/stream.ts'
import { inflate } from './blob-source.ts'
const codecs: TextCodecs = {
  narrow(bytes, encoding) {
    if (encoding) return new TextDecoder(encoding, { fatal: true }).decode(bytes)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return new TextDecoder('shift_jis', { fatal: true }).decode(bytes)
    }
  },
  utf8: (text) => new TextEncoder().encode(text),
  inflate,
  async deflate(bytes) {
    const stream = new Blob([Uint8Array.from(bytes).buffer])
      .stream()
      .pipeThrough(new CompressionStream('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  },
}
export const readText = (bytes: Uint8Array, mode = '', encoding?: string) =>
  decodeTextStream(bytes, codecs, mode, encoding)
export const writeText = (text: string, mode = '') => encodeTextStream(text, codecs, mode)
export async function readScript(
  bytes: Uint8Array,
  mode = '',
  encoding?: string,
): Promise<string | Uint8Array> {
  const offset = modeOffset(mode)
  if (offset > bytes.length) throw new Error('Script stream offset exceeds file length')
  const source = bytes.subarray(offset)
  if (source.length > 64 * 1024 * 1024) throw new Error('Script stream exceeds 64 MiB budget')
  const tag = String.fromCharCode(...source.subarray(0, 4))
  if (tag === 'TJS2' || tag === 'KBAD') return source
  return readText(bytes, mode, encoding)
}
