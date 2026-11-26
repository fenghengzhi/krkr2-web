import { inflate, inflateRaw } from './blob-source.ts'
import { createArchiveInflatePool } from './archive-inflater.ts'
import { findXp3Archive, hasXp3Signature, readXp3 } from '../../formats/xp3/archive.ts'
import { readZip } from '../../formats/zip/archive.ts'
import { MAX_RESOURCE_BYTES, type Resource } from '../../engine/ports/storage.ts'
import { normalizePath } from '../../engine/storage/resolver.ts'
import type { GameFile } from '../../protocol/session.ts'
import { resolveFiles, type SourceFile } from './source-files.ts'
import type { HttpRangePool } from './http-range.ts'
import { borrowResourceBlob } from '../../engine/storage/resource-source.ts'
import type { ZipNameEncoding } from '../../formats/zip/names.ts'
import { zipNameCodecs } from './zip-names.ts'
import { joinArchiveVolumes } from './archive-volumes.ts'

/** Prepare a complete mount before publishing any of its paths to the running session. */
export async function importResources(
  files: GameFile[],
  checkpoint: () => Promise<void>,
  pool?: HttpRangePool,
  options: { lazyArchives?: boolean; zipEncoding?: ZipNameEncoding } = {},
): Promise<Resource[]> {
  return importSources(await resolveFiles(files, checkpoint, pool), checkpoint, options)
}

export async function importSources(
  files: SourceFile[],
  checkpoint: () => Promise<void>,
  options: { lazyArchives?: boolean; zipEncoding?: ZipNameEncoding } = {},
): Promise<Resource[]> {
  if (files.length > 10000) throw new Error('Import exceeds 10,000 source files')
  const physical: Resource[] = []
  for (const file of files) {
    await checkpoint()
    const name = normalizePath(file.path),
      source = file.source
    if (name.includes('>')) throw new Error('Input filename contains an archive address delimiter')
    physical.push({
      name,
      size: source.size,
      source: {
        size: source.size,
        ...(source.borrowBlob ? { async borrowBlob(offset: number, length: number, check?: () => void | Promise<void>) {
          return borrowResourceBlob(source, offset, length, async () => { await checkpoint(); await check?.() })
        } } : {}),
        async read(offset, length) {
          await checkpoint()
          const bytes = await source.read(offset, length)
          await checkpoint()
          return bytes
        },
      },
      async read() {
        await checkpoint()
        if (source.size > MAX_RESOURCE_BYTES)
          throw new Error(`Resource exceeds decode budget: ${name}`)
        const bytes = await source.read(0, source.size)
        await checkpoint()
        return bytes
      },
    })
  }
  const mounted = await joinArchiveVolumes(physical, checkpoint)
  await checkpoint()
  if (options.lazyArchives) return mounted
  const resources: Resource[] = [], compressedSegments = createArchiveInflatePool()
  const add = (resource: Resource) => {
    if (resources.length >= 250000) throw new Error('Import exceeds 250,000 mounted resource names')
    resources.push(resource)
  }
  for (const resource of mounted) {
    const { name, source } = resource, containerIndex = resources.length
    if (!source) throw new Error('Imported file has no byte source: ' + name)
    add(resource)
    const prefix = await source.read(0, Math.min(source.size, 11)),
      zipMagic =
        prefix &&
        prefix[0] === 0x50 &&
        prefix[1] === 0x4b &&
        ((prefix[2] === 3 && prefix[3] === 4) || (prefix[2] === 5 && prefix[3] === 6))
    const xp3 = /\.xp3$/i.test(name) || hasXp3Signature(prefix) ? source
      : prefix[0] === 0x4d && prefix[1] === 0x5a
        ? (await findXp3Archive(source, { checkpoint }))?.source : undefined,
      entries = xp3
        ? await readXp3(xp3, inflate, { checkpoint, compressedSegments })
        : /\.zip$/i.test(name) || zipMagic
          ? await readZip(source, {
              inflate: (bytes, size) => inflateRaw(bytes, size, checkpoint),
              ...zipNameCodecs(options.zipEncoding),
              compressedRanges: compressedSegments,
              checkpoint,
            }, resource.zipDiskOffsets)
          : []
    if (xp3 || /\.zip$/i.test(name) || zipMagic)
      resources[containerIndex] = { ...resources[containerIndex]!, archiveKind: xp3 ? 'xp3' : 'zip' }
    for (const entry of entries) {
      await checkpoint()
      const canonical = name + '>' + entry.name
      add({ ...entry, aliasOf: canonical })
      add({ ...entry, name: canonical })
    }
  }
  await checkpoint()
  return resources
}
