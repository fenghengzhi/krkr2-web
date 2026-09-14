import { readFileSync } from 'node:fs'
import { BlobSource, inflateRaw } from '../../src/backends/files/blob-source.ts'
import { readZip, type ZipCodecs } from '../../src/formats/zip/archive.ts'

export const zipReference = JSON.parse(
  readFileSync(new URL('../fixtures/zip/reference.json', import.meta.url), 'utf8'),
) as {
  cases: {
    file: string
    size: number
    sha256: string
    entries: { name: string; size: number; sha256: string; crc32: number; method: number }[]
  }[]
}
export const zipFixture = (name = '8-stream0-local640-zip640.zip') =>
  Buffer.from(readFileSync(new URL('../fixtures/zip/' + name, import.meta.url)))
export const zipCodecs: ZipCodecs = {
  inflate: inflateRaw,
  utf8: (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
  checkpoint: async () => {},
}
export const openZip = (bytes: Uint8Array, codecs: ZipCodecs = zipCodecs) =>
  readZip(new BlobSource(new Blob([Uint8Array.from(bytes).buffer])), codecs)

/** Locate classic central headers in independently authored test inputs, for corruptions. */
export function centralRecords(bytes: Buffer) {
  const end = bytes.length - 22,
    central = bytes.readUInt32LE(end + 16),
    count = bytes.readUInt16LE(end + 10),
    records = []
  let at = central
  for (let i = 0; i < count; i++) {
    const nameLength = bytes.readUInt16LE(at + 28),
      extraLength = bytes.readUInt16LE(at + 30),
      commentLength = bytes.readUInt16LE(at + 32),
      local = bytes.readUInt32LE(at + 42)
    records.push({
      at,
      local,
      name: bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      data: local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return { end, central, records }
}
