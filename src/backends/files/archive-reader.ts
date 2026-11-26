import { createArchiveInflatePool } from './archive-inflater.ts'
import type { DeflateRangePool } from '../../formats/binary/deflate-ranges.ts'
import type { ArchiveIndex, ArchiveReader, Resource } from '../../engine/ports/storage.ts'
import { openResourceSource } from '../../engine/storage/resource-source.ts'
import { findXp3Archive, hasXp3Signature, readXp3 } from '../../formats/xp3/archive.ts'
import { readZip } from '../../formats/zip/archive.ts'
import { locateExecutableZip } from '../../formats/zip/executable.ts'
import { inflate, inflateRaw } from './blob-source.ts'
import type { ZipNameEncoding } from '../../formats/zip/names.ts'
import { zipNameCodecs } from './zip-names.ts'
import { joinArchiveVolumes } from './archive-volumes.ts'

export const archiveReader: ArchiveReader = {
  joinVolumes: joinArchiveVolumes,
  async probeArchive(resource, checkpoint) {
    if (resource.zipDiskOffsets) return true
    const { source } = await openResourceSource(resource, { checkpoint }),
      bytes = await source.read(0, Math.min(source.size, 11))
    await checkpoint()
    return hasXp3Signature(bytes) || (bytes[0] === 0x4d && bytes[1] === 0x5a) || zipSignature(bytes)
  },
  async probeXp3(resource, checkpoint) {
    if (resource.zipDiskOffsets) return false
    const { source } = await openResourceSource(resource, { checkpoint })
    const prefix = await source.read(0, Math.min(source.size, 11))
    if (prefix[0] !== 0x4d || prefix[1] !== 0x5a) return hasXp3Signature(prefix)
    if (await locateExecutableZip(source, checkpoint)) return false
    return !!await findXp3Archive(source, { checkpoint })
  },
  open: openArchive,
  openDistribution: (resource, checkpoint) => openArchive(resource, checkpoint, undefined, undefined, true),
}

function zipSignature(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))
}

export async function openArchive(resource: Resource, checkpoint: () => Promise<void>, pool?: DeflateRangePool,
  zipEncoding?: ZipNameEncoding, distributionOnly = false): Promise<ArchiveIndex | undefined> {
  const { source } = await openResourceSource(resource, { checkpoint })
  const prefix = await source.read(0, Math.min(11, source.size))
  await checkpoint()
  const native = /\.xp3$/i.test(resource.name) || hasXp3Signature(prefix)
  const mz = !native && prefix[0] === 0x4d && prefix[1] === 0x5a
  const executableZip = mz && !resource.zipDiskOffsets ? await locateExecutableZip(source, checkpoint) : undefined
  // A stored XP3 inside a ZIP installer can itself be aligned. Identify the
  // outer ZIP directory before looking for a self-combined KRKR executable.
  const xp3 = native ? source : !distributionOnly && mz && !resource.zipDiskOffsets && !executableZip
    ? (await findXp3Archive(source, { checkpoint }))?.source : undefined
  if (xp3) {
    if (distributionOnly) return
    return { kind: 'xp3', entries: await readXp3(xp3, inflate, { checkpoint, compressedSegments: pool ?? createArchiveInflatePool() }) }
  }
  if (executableZip || resource.zipDiskOffsets || zipSignature(prefix) || /\.zip$/i.test(resource.name)) {
    return { kind: 'zip', entries: await readZip(source, {
      inflate: (bytes, size) => inflateRaw(bytes, size, checkpoint), checkpoint, compressedRanges: pool ?? createArchiveInflatePool(),
      ...zipNameCodecs(zipEncoding),
    }, resource.zipDiskOffsets, executableZip) }
  }
  return undefined
}

/** The playing Session owns a shared cache and bounded forward inflater cursors
 * across all its archives. Metadata-only callers can use archiveReader. */
export function createSessionArchiveReader(distribution?: Pick<ArchiveReader, 'compact'>, zipEncoding?: ZipNameEncoding) {
  const pool = createArchiveInflatePool(true)
  return { ...archiveReader, open: (resource: Resource, checkpoint: () => Promise<void>) => openArchive(resource, checkpoint, pool, zipEncoding),
    openDistribution: (resource: Resource, checkpoint: () => Promise<void>) => openArchive(resource, checkpoint, pool, zipEncoding, true),
    compact() { pool.compact(); distribution?.compact?.() }, dispose() { pool.dispose() } }
}
