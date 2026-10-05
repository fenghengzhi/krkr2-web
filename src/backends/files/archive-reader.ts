import type { ArchiveReader } from '../../engine/ports/storage.ts'
import { openResourceSource } from '../../engine/storage/resource-source.ts'
import { findXp3Archive, hasXp3Signature, readXp3 } from '../../formats/xp3/archive.ts'
import { readZip } from '../../formats/zip/archive.ts'
import { inflate, inflateRaw } from './blob-source.ts'

export const archiveReader: ArchiveReader = {
  async probeArchive(resource, checkpoint) {
    const { source } = await openResourceSource(resource, { checkpoint }),
      bytes = await source.read(0, Math.min(source.size, 11))
    await checkpoint()
    return hasXp3Signature(bytes) || (bytes[0] === 0x4d && bytes[1] === 0x5a) ||
      (bytes[0] === 0x50 && bytes[1] === 0x4b &&
        ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6)))
  },
  async probeXp3(resource, checkpoint) {
    const { source } = await openResourceSource(resource, { checkpoint })
    return !!await findXp3Archive(source, { checkpoint })
  },
  async open(resource, checkpoint) {
    const { source } = await openResourceSource(resource, { checkpoint }),
      prefix = await source.read(0, Math.min(11, source.size)),
      zip = prefix[0] === 0x50 && prefix[1] === 0x4b &&
        ((prefix[2] === 3 && prefix[3] === 4) || (prefix[2] === 5 && prefix[3] === 6))
    await checkpoint()
    const xp3 = /\.xp3$/i.test(resource.name) || hasXp3Signature(prefix) ? source
      : prefix[0] === 0x4d && prefix[1] === 0x5a
        ? (await findXp3Archive(source, { checkpoint }))?.source : undefined
    if (xp3) return { kind: 'xp3', entries: await readXp3(xp3, inflate, { checkpoint }) }
    if (/\.zip$/i.test(resource.name) || zip) return { kind: 'zip', entries: await readZip(source, {
      inflate: (bytes, size) => inflateRaw(bytes, size, checkpoint), checkpoint,
      utf8: (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    }) }
    return undefined
  },
}
