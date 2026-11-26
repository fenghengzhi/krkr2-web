import type { Resource } from '../ports/storage.ts'
import { openResourceSource, resourceReadBounds } from '../storage/resource-source.ts'
import { parseEngineConfig } from './config-file.ts'

const firstOffset = 512 * 1024, lastOffset = 5 * 1024 * 1024, blockSize = 64 * 1024
const marker = Uint8Array.of(88, 79, 80, 84, 95, 69, 77, 66, 69, 68, 95, 65, 82, 69, 65, 95)

export interface EmbeddedConfigReader {
  /** The same platform ANSI decoding policy as external .cf files. */
  decode(bytes: Uint8Array): Promise<string>
  checkpoint?(): void | Promise<void>
  warn?(message: string): void
}

/** Read only XOPT's ordinary first configuration string. SysInitImpl searches
 * 16-byte-aligned offsets in [512 KiB, 5 MiB), then skips the 16-byte signature
 * and LE capacity field. ConfMainFrameUnit defines that capacity as the entire
 * reserved area; this reader neither interprets nor decodes later sections.
 * Range sources keep large combined executables out of the whole-file path.
 * Invalid/truncated areas fail explicitly instead of reproducing native's
 * unchecked pointer reads. Missing markers and short placeholders are empty.
 * Old whole-file-only embeddings above five MiB skip this optional layer. */
export async function readEmbeddedConfig(
  resource: Resource,
  { decode, checkpoint, warn }: EmbeddedConfigReader,
): Promise<Map<string, string>> {
  resourceReadBounds(resource.size, 0, 0)
  await checkpoint?.()
  const end = Math.min(resource.size, lastOffset)
  if (end - firstOffset < 16) return new Map()
  if (!resource.source && resource.size > lastOffset) {
    warn?.(`Skipping embedded configuration for ${resource.name}: no range source; whole-file reads above 5 MiB are disabled`)
    await checkpoint?.()
    return new Map()
  }
  const { source } = await openResourceSource(resource, { fallbackLimit: lastOffset, checkpoint })
  let blockAt = firstOffset
  let block: Uint8Array = new Uint8Array(0)
  const load = async (position: number) => {
    blockAt = firstOffset + Math.floor((position - firstOffset) / blockSize) * blockSize
    block = await source.read(blockAt, Math.min(blockSize, end - blockAt))
  }
  const readOptions = async (offset: number) => {
    const header = offset + 16, textAt = header + 4
    if (textAt > end) throw new Error('Truncated embedded configuration capacity')
    if (header >= blockAt + block.length) await load(header)
    const capacity = new DataView(block.buffer, block.byteOffset + header - blockAt, 4).getUint32(0, true)
    if (capacity === 0 || capacity > resource.size - textAt)
      throw new Error('Embedded configuration capacity is outside the resource')
    // A valid area may reserve bytes beyond native's scan window. Only the
    // first terminated string must fit both that window and the declared area.
    const limit = Math.min(textAt + capacity, end), parts: Uint8Array[] = []
    let length = 0
    for (let at = textAt; at < limit;) {
      if (at >= blockAt + block.length) await load(at)
      const bytes = block.subarray(at - blockAt, Math.min(block.length, limit - blockAt)), zero = bytes.indexOf(0)
      const part = zero < 0 ? bytes : bytes.subarray(0, zero)
      parts.push(part); length += part.length
      if (zero >= 0) {
        const text = new Uint8Array(length)
        let written = 0
        for (const part of parts) { text.set(part, written); written += part.length }
        await checkpoint?.()
        const decoded = await decode(text)
        await checkpoint?.()
        return parseEngineConfig(decoded)
      }
      at += bytes.length
    }
    throw new Error('Unterminated embedded configuration within the readable area')
  }
  for (let at = firstOffset; at < end; at += blockSize) {
    await load(at)
    for (let within = 0; within + 16 <= block.length; within += 16) {
      let matches = true
      for (let byte = 0; byte < 16; byte++) if (block[within + byte] !== marker[byte]) { matches = false; break }
      if (matches) return readOptions(at + within)
    }
  }
  return new Map()
}
