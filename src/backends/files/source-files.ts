import type { ByteSource } from '../../engine/ports/storage.ts'
import { normalizePath } from '../../engine/storage/resolver.ts'
import type { GameFile } from '../../protocol/session.ts'
import { BlobSource } from './blob-source.ts'
import { HttpRangePool, remoteUrl } from './http-range.ts'

export interface SourceFile {
  path: string
  source: ByteSource
  remoteIdentity?: string
}

/** The caller owns remote source lifetimes, including failed or cancelled batches. */
export async function resolveFiles(
  files: GameFile[],
  checkpoint: () => Promise<void>,
  pool?: HttpRangePool,
): Promise<SourceFile[]> {
  if (files.length > 10000) throw new Error('Import exceeds 10,000 source files')
  // Validate the whole batch before opening a network connection.
  for (const file of files) {
    await checkpoint()
    if (normalizePath(file.path).includes('>'))
      throw new Error('Input filename contains an archive address delimiter')
    if ('url' in file) {
      remoteUrl(file.url)
      if (!pool) throw new Error('Remote files require a session-owned HTTP pool')
    }
  }
  const resolved: SourceFile[] = []
  for (const file of files) {
    await checkpoint()
    if ('blob' in file) resolved.push({ path: file.path, source: new BlobSource(file.blob) })
    else {
      const source = await pool!.open(file.url)
      await checkpoint()
      resolved.push({ path: file.path, source, remoteIdentity: source.identity })
    }
  }
  await checkpoint()
  return resolved
}
