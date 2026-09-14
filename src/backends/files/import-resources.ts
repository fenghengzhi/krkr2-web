import { inflate, inflateRaw } from './blob-source.ts'
import { hasXp3Signature, readXp3 } from '../../formats/xp3/archive.ts'
import { readZip } from '../../formats/zip/archive.ts'
import { MAX_RESOURCE_BYTES, type Resource } from '../../engine/ports/storage.ts'
import { normalizePath } from '../../engine/storage/resolver.ts'
import type { GameFile } from '../../protocol/session.ts'
import { resolveFiles, type SourceFile } from './source-files.ts'
import type { HttpRangePool } from './http-range.ts'

/** Prepare a complete mount before publishing any of its paths to the running session. */
export async function importResources(
  files: GameFile[],
  checkpoint: () => Promise<void>,
  pool?: HttpRangePool,
): Promise<Resource[]> {
  return importSources(await resolveFiles(files, checkpoint, pool), checkpoint)
}

export async function importSources(
  files: SourceFile[],
  checkpoint: () => Promise<void>,
): Promise<Resource[]> {
  if (files.length > 10000) throw new Error('Import exceeds 10,000 source files')
  const resources: Resource[] = [],
    utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const add = (resource: Resource) => {
    if (resources.length >= 250000) throw new Error('Import exceeds 250,000 mounted resource names')
    resources.push(resource)
  }
  for (const file of files) {
    await checkpoint()
    const name = normalizePath(file.path),
      source = file.source
    if (name.includes('>')) throw new Error('Input filename contains an archive address delimiter')
    add({
      name,
      size: source.size,
      async read() {
        await checkpoint()
        if (source.size > MAX_RESOURCE_BYTES)
          throw new Error(`Resource exceeds decode budget: ${name}`)
        const bytes = await source.read(0, source.size)
        await checkpoint()
        return bytes
      },
    })
    const prefix = await source.read(0, Math.min(source.size, 11)),
      zipMagic =
        prefix &&
        prefix[0] === 0x50 &&
        prefix[1] === 0x4b &&
        ((prefix[2] === 3 && prefix[3] === 4) || (prefix[2] === 5 && prefix[3] === 6))
    const entries =
      /\.xp3$/i.test(name) || hasXp3Signature(prefix)
        ? await readXp3(source, inflate)
        : /\.zip$/i.test(name) || zipMagic
          ? await readZip(source, {
              inflate: (bytes, size) => inflateRaw(bytes, size, checkpoint),
              utf8: (bytes) => utf8.decode(bytes),
              checkpoint,
            })
          : []
    for (const entry of entries) {
      await checkpoint()
      add(entry)
      add({ ...entry, name: name + '>' + entry.name })
    }
  }
  await checkpoint()
  return resources
}
