import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const cloneCdAudioSamples = [
  { frame: 0, left: 8192, right: -16384 },
  { frame: 24, left: 8192, right: -16384 },
  { frame: 25, left: 8192, right: 16384 },
  { frame: 49, left: 8192, right: 16384 },
  { frame: 50, left: -8192, right: -16384 },
  { frame: 99, left: -8192, right: 16384 },
  { frame: 100, left: 8192, right: -16384 },
  { frame: 176399, left: -8192, right: 16384 },
] as const

interface CloneCdManifest {
  schema: 1
  commit: string
  complete: boolean
  author: { name: string; version: string; commit: string; sourceSha256: string }
  volume: string
  sectorBytes: number
  files: Array<{ name: string; bytes: number; sha256: string }>
  audio: { track: number; startSector: number; sectors: number; frames: number; sampleRate: number; channels: number;
    encoding: string; pcmSha256: string }
  data: { track: number; startSector: number; mode: string; payloadBytes: number; sectors: number }
  source: { name: string; bytes: number; sha256: string }
  layout: { tracks: Array<{ number: number; mode: number; index0: number | null; index1: number; control: number }>;
    leadoutSector: number; firstAudioSectors: number }
  readback: { tool: string; isoMatched: boolean; audioMatched: boolean; iso: { bytes: number; sha256: string };
    pcmBytes: number; pcmSha256: string; samples: Array<{ frame: number; left: number; right: number }> }
}

/** The hosted independent cue2ccd 1.1.0 author output, with whole-track bchunk
 * readback. SUB stays in the artifact; the ordinary player receives CCD+IMG. */
export function cloneCdDiscInput() {
  const directory = new URL('../../out/verification/clone-cd-game/', import.meta.url),
    manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8')) as CloneCdManifest,
    { audio, data, layout, source, readback, author } = manifest,
    tracks = layout?.tracks
  if (manifest.schema !== 1 || !manifest.complete || manifest.volume !== 'KRKR_STORY' || manifest.sectorBytes !== 2352 ||
      author?.name !== 'cue2ccd' || author.version !== '1.1.0' || author.commit !== 'aa74f53b6d211e4ac844bd7c8fb2b69ea482669d' ||
      author.sourceSha256 !== '9d9ef46eec8671a01556a84ce0b1da9de0ab55654992477fda370994af1f8d93' ||
      audio?.track !== 1 || audio.startSector !== 0 || audio.sectors !== 300 || audio.frames !== 176400 ||
      audio.sampleRate !== 44100 || audio.channels !== 2 || audio.encoding !== 's16le' ||
      data?.track !== 2 || data.startSector !== 300 || data.mode !== 'MODE1/2352' || data.payloadBytes !== 2048 ||
      !Number.isSafeInteger(data.sectors) || data.sectors <= 0 || source?.name !== 'boot-source.iso' || source.bytes !== data.sectors * 2048 ||
      tracks?.length !== 2 || tracks.some((track, index) => track.number !== index + 1 || track.mode !== index ||
        track.index1 !== index * 300 || track.control !== index * 4 || track.index0 !== null && track.index0 !== track.index1) ||
      layout.leadoutSector !== 300 + data.sectors || layout.firstAudioSectors !== 300 ||
      readback?.tool !== 'bchunk' || !readback.isoMatched || !readback.audioMatched ||
      readback.iso.bytes !== source.bytes || readback.iso.sha256 !== source.sha256 ||
      readback.pcmBytes !== 176400 * 4 || readback.pcmSha256 !== audio.pcmSha256 ||
      JSON.stringify(readback.samples) !== JSON.stringify(cloneCdAudioSamples) ||
      process.env.GITHUB_SHA && manifest.commit !== process.env.GITHUB_SHA)
    throw new Error('Incomplete or mismatched independent CloneCD game disc')
  const files = ['boot-clonecd-source.ccd', 'boot-clonecd-source.img'].map((name) => {
    const row = manifest.files.find((file) => file.name === name), buffer = readFileSync(new URL(name, directory))
    if (!row || buffer.length !== row.bytes || createHash('sha256').update(buffer).digest('hex') !== row.sha256 ||
        name.endsWith('.img') && buffer.length !== layout.leadoutSector * 2352)
      throw new Error('CloneCD bytes differ from the authoring manifest: ' + name)
    return { name, buffer, mimeType: 'application/octet-stream' }
  })
  return { files, manifest }
}

// Independently expand Annex B as a bit sequence: b[n+15] = b[n]+b[n+1]
// over GF(2). Check every byte against the published cdrtools mask digest.
export function referenceCdMask(): Uint8Array {
  const bits = new Uint8Array(2340 * 8), bytes = new Uint8Array(2340)
  bits[0] = 1
  for (let bit = 0; bit < bits.length; bit++) {
    if (bit >= 15) bits[bit] = bits[bit - 15]! ^ bits[bit - 14]!
    bytes[bit >>> 3] = bytes[bit >>> 3]! | (bits[bit]! << (bit & 7))
  }
  if (createHash('sha256').update(bytes).digest('hex') !== '12e23b47b7728bbf5fb5c8e36a3aa7040df6e6586f1cc5e35a9eafd83fedd4b6')
    throw new Error('Reference mask differs from cdrtools libedc/scramble_table')
  return bytes
}

export function scrambledCloneCdDiscInput() {
  const original = cloneCdDiscInput(), mask = referenceCdMask()
  const files = original.files.map((file) => {
    if (file.name.endsWith('.ccd')) {
      const descriptor = file.buffer.toString('ascii')
      const changed = descriptor.replace(/^(DataTracksScrambled[ \t]*=[ \t]*)0(?=[ \t]*\r?$)/im, (_, key: string) => key + '1')
      if (changed === descriptor) throw new Error('Missing CloneCD data representation flag')
      return { ...file, buffer: Buffer.from(changed, 'ascii') }
    }
    const buffer = Buffer.from(file.buffer)
    for (let sector = original.manifest.data.startSector; sector < original.manifest.layout.leadoutSector; sector++)
      for (let i = 0; i < mask.length; i++) buffer[sector * 2352 + 12 + i]! ^= mask[i]!
    return { ...file, buffer }
  })
  return { files, manifest: { original: original.manifest, dataTracksScrambled: 1,
    files: files.map(({ name, buffer }) => ({ name, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') })) } }
}
