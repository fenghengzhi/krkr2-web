import { readFileSync } from 'node:fs'

export const tlgBytes = readFileSync(new URL('../fixtures/tlg-reference.bin', import.meta.url))
export const tlgManifest: {
  cases: number
  pixels: number
  sha256: string
  entries: { id: string; offset: number; size: number; sha256: string }[]
} = JSON.parse(readFileSync(new URL('../fixtures/tlg-reference.json', import.meta.url), 'utf8'))

export function tlgFixture(id: string): Buffer {
  const entry = tlgManifest.entries.find((entry) => entry.id === id)
  if (!entry) throw new Error(`Unknown TLG fixture: ${id}`)
  return tlgBytes.subarray(entry.offset, entry.offset + entry.size)
}
export function tlgU32(value: number): Buffer {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return bytes
}
export function tlgTags(entries: [string, string][]): Buffer {
  return Buffer.from(
    entries
      .map(
        ([key, value]) => `${Buffer.byteLength(key)}:${key}=${Buffer.byteLength(value)}:${value},`,
      )
      .join(''),
  )
}
export function tlgSds(raw: Uint8Array, chunks: [string, Uint8Array][]): Buffer {
  return Buffer.concat([
    Buffer.from('TLG0.0\x00sds\x1a'),
    tlgU32(raw.length),
    raw,
    ...chunks.flatMap(([name, bytes]) => [Buffer.from(name), tlgU32(bytes.length), bytes]),
  ])
}
