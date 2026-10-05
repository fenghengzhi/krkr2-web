import {
  decodeTextStream,
  encodeTextStream,
  modeOffset,
  type TextCodecs,
} from '../../formats/text/stream.ts'
import { inflate } from './blob-source.ts'
import { CompressionError } from '../../formats/binary/compression-error.ts'
import { BinaryWriter } from '../../formats/binary/writer.ts'
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
    const reader = stream.getReader(), output = new BinaryWriter()
    let ended = false
    try {
      while (true) {
        const { value, done } = await reader.read().catch((error: unknown) => {
          throw new CompressionError('deflate', error instanceof Error ? error.message : 'Compression failed', { cause: error })
        })
        if (done) { ended = true; break }
        output.append(value)
      }
      return output.finish()
    } finally {
      // Only this private codec reader's rejection is classified above.
      // Allocation/budget errors and unsupported CompressionStream stay raw.
      if (!ended) await reader.cancel().catch(() => undefined)
    }
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
