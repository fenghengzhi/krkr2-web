import { readFileSync } from 'node:fs'
export interface ImageFixture {
  name: string
  width: number
  height: number
  offset: number
  size: number
  sha256: string
  rgbaOffset: number
  indicesOffset?: number
  grayscale: boolean
  metadata?: Record<string, string>
}
export const imageBytes = readFileSync(new URL('../fixtures/image-reference.bin', import.meta.url))
export const imageManifest: { cases: number; sha256: string; entries: ImageFixture[] } = JSON.parse(
  readFileSync(new URL('../fixtures/image-reference.json', import.meta.url), 'utf8'),
)
export function imageFixture(name: string): Buffer {
  const entry = imageManifest.entries.find((entry) => entry.name === name)
  if (!entry) throw new Error(`Unknown image fixture: ${name}`)
  return imageBytes.subarray(entry.offset, entry.offset + entry.size)
}
