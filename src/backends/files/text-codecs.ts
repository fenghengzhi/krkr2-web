import { decodeTextStream, encodeTextStream, type TextCodecs } from '../../formats/text/stream.ts'
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
  if (bytes[0] === 0x54 && bytes[1] === 0x4a && bytes[2] === 0x53 && bytes[3] === 0x32) return bytes
  return readText(bytes, mode, encoding)
}
