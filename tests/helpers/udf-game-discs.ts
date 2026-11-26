import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

interface UdfImage {
  name: string
  mode: 'source' | 'bytecode'
  revision: string
  volume: string
  bytes: number
  sha256: string
  complete: boolean
  layout: { blockSize: number; revision: number; partitionMapTypes: number[]; isoDescriptors: number }
  files: Array<{ name: string; bytes: number; sha256: string }>
  kernelReadback: boolean
  sevenZipReadback: boolean
}
interface UdfManifest { schema: 1; commit: string; complete: boolean; images: UdfImage[] }

/** These are original mkudffs + Linux-written UDF-only files, independently
 * extracted by the kernel and 7-Zip on the hosted authoring runner. */
export function udfGameDisc(binary: boolean) {
  const base = new URL('../../out/verification/disc-volumes/', import.meta.url),
    manifest = JSON.parse(readFileSync(new URL('udf-manifest.json', base), 'utf8')) as UdfManifest,
    name = binary ? 'boot-udf201-bytecode.iso' : 'boot-udf102-source.iso',
    row = manifest.images.find((image) => image.name === name)
  if (manifest.schema !== 1 || !manifest.complete || !row?.complete || !row.kernelReadback || !row.sevenZipReadback ||
      row.volume !== 'KRKR_STORY' || row.mode !== (binary ? 'bytecode' : 'source') || row.bytes !== 32 * 1024 ** 2 ||
      row.layout.blockSize !== 2048 || row.layout.revision !== (binary ? 0x0201 : 0x0102) ||
      row.layout.partitionMapTypes.join(',') !== '1' || row.layout.isoDescriptors !== 0 ||
      process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA)
    throw new Error('Incomplete or mismatched independent UDF game disc')
  const buffer = readFileSync(new URL(name, base))
  if (buffer.length !== row.bytes || createHash('sha256').update(buffer).digest('hex') !== row.sha256)
    throw new Error('UDF game disc bytes differ from the authoring manifest')
  return { files: [{ name, buffer, mimeType: 'application/octet-stream' }], manifest }
}
