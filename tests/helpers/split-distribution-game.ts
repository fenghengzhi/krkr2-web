import { createHash } from 'node:crypto'
import { combinedLauncherDistribution } from './combined-launcher.ts'
import { centralRecords } from './zip-fixtures.ts'
import { splitZipFixture } from './split-zip.ts'

export type SplitDistributionKind = 'numbered' | 'pkzip'
export async function splitDistributionGame(kind: SplitDistributionKind) {
  const binary = kind === 'pkzip', game = await combinedLauncherDistribution(binary),
    records = centralRecords(game.bytes), body = records.records.find((record) => record.name === 'Release/Game.exe')
  if (!body) throw new Error('Combined KAG ZIP has no original game member')
  const packed = game.bytes.readUInt32LE(body.at + 20)
  if (packed < 4) throw new Error('Original KAG member has no useful compressed split boundary')
  // Split the actual method-8 stream of the unmodified original KAG package,
  // not padding, a header, or a directory-only tail.
  const cut = body.data + Math.floor(packed / 2), chunks = kind === 'numbered'
    ? [game.bytes.subarray(0, cut), game.bytes.subarray(cut)]
    : splitZipFixture(game.bytes, [cut]),
    names = kind === 'numbered' ? ['release.zip.001', 'release.zip.002'] : ['release.z01', 'release.zip'],
    volumes = chunks.map((bytes, index) => ({ name: names[index]!, bytes,
      sha256: createHash('sha256').update(bytes).digest('hex') }))
  const last = chunks[chunks.length - 1]!, eocd = last.length - 22,
    diskFields = { lastDisk: last.readUInt16LE(eocd + 4), directoryDisk: last.readUInt16LE(eocd + 6),
      directoryOffset: last.readUInt32LE(eocd + 16) }
  if (kind === 'pkzip' && (diskFields.lastDisk !== 1 || diskFields.directoryDisk !== 1))
    throw new Error('The PKZIP fixture did not retain its two-volume addresses')
  return { binary, kind, volumes, evidence: { ...game.evidence, kind,
    diskFields,
    cut: { logicalOffset: cut, member: body.name, dataStart: body.data, compressedBytes: packed,
      insideCompressedMember: cut > body.data && cut < body.data + packed },
    volumes: volumes.map(({ name, bytes, sha256 }) => ({ name, bytes: bytes.length, sha256 })),
    joinedSha256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
    scope: kind === 'numbered' ? 'Ordinary byte-split ZIP, unchanged logical bytes; all volumes supplied in reverse selection order.'
      : 'Classic PKZIP disk-relative fields, no leading split signature; all volumes supplied through a remote manifest in reverse selection order.' } }
}
