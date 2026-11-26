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
  remapping?: { packetBlocks: number; originalPacketCleared: boolean; originalPacketSha256: string; mappedPacketSha256: string;
    originalLogicalPacket: number; originalPhysicalPacket: number; mappedPhysicalPacket: number; fsdLogicalBlock: number;
    tables: Array<{ location: number; sha256Before: string; sha256After: string }> }
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

/** A separate DVD-RW formatter run. Its real FSD packet has been moved into
 * mkudffs' reserved sparing slot and the old packet cleared before the Linux
 * read-only tree/hash comparison. No production reader authors these bytes. */
export function udfSparableGameDisc() {
  const base = new URL('../../out/verification/disc-volumes/', import.meta.url),
    manifest = JSON.parse(readFileSync(new URL('udf-sparable-manifest.json', base), 'utf8')) as UdfManifest,
    name = 'boot-udf201-sparable-source.iso', row = manifest.images.find((image) => image.name === name),
    remapping = row?.remapping
  if (manifest.schema !== 1 || !manifest.complete || manifest.images.length !== 1 || !row?.complete || !row.kernelReadback ||
      row.volume !== 'KRKR_STORY' || row.mode !== 'source' || row.bytes !== 32 * 1024 ** 2 ||
      row.layout.blockSize !== 2048 || row.layout.revision !== 0x0201 || row.layout.partitionMapTypes.join(',') !== '2' ||
      row.layout.isoDescriptors !== 0 || !remapping || remapping.packetBlocks !== 16 || !remapping.originalPacketCleared ||
      remapping.originalPhysicalPacket === remapping.mappedPhysicalPacket ||
      remapping.fsdLogicalBlock < remapping.originalLogicalPacket || remapping.fsdLogicalBlock >= remapping.originalLogicalPacket + 16 ||
      remapping.originalPacketSha256 !== remapping.mappedPacketSha256 || remapping.tables.length !== 2 ||
      remapping.tables.some((table) => table.sha256Before === table.sha256After) ||
      process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA)
    throw new Error('Incomplete independent UDF sparable game disc')
  const buffer = readFileSync(new URL(name, base)), original = remapping.originalPhysicalPacket * 2048,
    mapped = remapping.mappedPhysicalPacket * 2048, packetBytes = 16 * 2048
  if (buffer.length !== row.bytes || createHash('sha256').update(buffer).digest('hex') !== row.sha256 ||
      original < 0 || mapped < 0 || original + packetBytes > buffer.length || mapped + packetBytes > buffer.length ||
      !buffer.subarray(original, original + packetBytes).every((byte) => byte === 0) ||
      createHash('sha256').update(buffer.subarray(mapped, mapped + packetBytes)).digest('hex') !== remapping.originalPacketSha256)
    throw new Error('UDF sparable bytes or relocated packet differ from the authoring manifest')
  return { files: [{ name, buffer, mimeType: 'application/octet-stream' }], manifest }
}

export function udfMetadataGameDisc(bridge: boolean) {
  const base = new URL('../../out/verification/disc-volumes/', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL(bridge ? 'udf-bridge-manifest.json' : 'udf-metadata-manifest.json', base), 'utf8')) as {
    name: string; complete: boolean; bridge: boolean; commit: string; revision: number; bytes: number; sha256: string;
    duplicate: boolean; primary: number; mirror: number; partitionMaps: string[]; tree: Record<string, string | null>; isoTree?: Record<string, string | null>
  }
  const name = bridge ? 'boot-udf250-bridge-source.iso' : 'boot-udf250-metadata-source.iso'
  if (!manifest.complete || manifest.name !== name || manifest.bridge !== bridge || manifest.revision !== 0x250 ||
      !manifest.duplicate || manifest.primary === manifest.mirror || manifest.partitionMaps.join(',') !== 'physical,metadata' ||
      !manifest.tree['DiscGame/data.xp3'] || !manifest.tree['Routes/開幕.tjs'] ||
      process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA)
    throw new Error('Incomplete IMAPI game disc or independent directory readback')
  const buffer = readFileSync(new URL(name, base))
  if (buffer.length !== manifest.bytes || createHash('sha256').update(buffer).digest('hex') !== manifest.sha256)
    throw new Error('IMAPI game disc bytes differ from the readback manifest')
  return { files: [{ name, buffer, mimeType: 'application/octet-stream' }], manifest }
}
