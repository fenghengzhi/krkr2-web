import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { BlobSource, inflateRaw } from '../../src/backends/files/blob-source.ts'
import { readText } from '../../src/backends/files/text-codecs.ts'
import { readZip } from '../../src/formats/zip/archive.ts'
import { xp3Fixture } from './xp3-fixtures.ts'

export type PatchLabel = 'base' | 'patch' | 'patch2' | 'patch4'
export const patchColors = { base: 0x112233, patch: 0x445566, patch2: 0x778899, patch4: 0xaabbcc } as const

/** Independent, uncompressed 3x2 RGB bitmap; no production image encoder. */
export function solidBmp(color: number): Buffer {
  const bytes = Buffer.alloc(54 + 12 * 2)
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(3, 18); bytes.writeInt32LE(2, 22)
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(24, 34)
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
    const at = 54 + y * 12 + x * 3
    bytes[at] = color & 255; bytes[at + 1] = (color >>> 8) & 255; bytes[at + 2] = color >>> 16
  }
  return bytes
}

/** Deliberately differs from KAG's registration order. Missing patch3 means
 * the original loop must leave patch4 unregistered even though it is imported. */
export function archivePatchFiles(options: {
  override?: (label: PatchLabel) => string
  scenario?: (label: PatchLabel) => string
} = {}): { path: string; bytes: Buffer }[] {
  return (['patch2', 'patch4', 'patch', 'base'] as const).map((label) => {
    const base = label === 'base', system = base ? 'system/' : '', image = base ? 'image/' : '',
      scenario = base ? 'scenario/' : ''
    return { path: base ? 'data.xp3' : label + '.xp3', bytes: xp3Fixture({
      [system + 'patch-value.tjs']: JSON.stringify(label),
      [system + 'Override.tjs']: options.override?.(label) ?? `global.patchOverride=${JSON.stringify(label)};`,
      [image + 'patch-probe.bmp']: solidBmp(patchColors[label]),
      [scenario + 'first.ks']: options.scenario?.(label) ??
        `[iscript]\nDebug.message("patch-first:${label}");\n[endscript]\n[s]\n`,
    }).bytes }
  })
}

/** Execute the fixed original path-registration program, not a rewritten
 * stand-in. This is explicitly a source slice, not a complete KAG startup. */
export async function kagAutoPathProgram() {
  const zip = readFileSync(new URL('../fixtures/compatibility/kag3_template.zip', import.meta.url)),
    hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
  assert.equal(hash(zip), 'bc14c13281aa9d00e714e6b9d1053d8d0cbde639cf6b7c84d7715551baea00de')
  const files = await readZip(new BlobSource(new Blob([Uint8Array.from(zip).buffer])), {
    inflate: inflateRaw, utf8: (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    checkpoint: async () => {},
  }), entry = files.find((file) => file.name === 'system/Initialize.tjs')!
  assert(entry)
  const bytes = await entry.read(), sha256 = hash(bytes)
  assert.equal(sha256, '01f2b1544a686dc77a4e24bcaf7ec50d564a8de92447c64f51615539b3b41cab')
  const source = (await readText(bytes)).split(/\r?\n/).slice(47, 95).join('\n') + '\n'
  assert(source.startsWith('function useArchiveIfExists(name)'))
  assert(source.includes('delete useArchiveIfExists;'))
  return { source, sha256, sliceSha256: hash(source), firstLine: 48, lastLine: 95 }
}
