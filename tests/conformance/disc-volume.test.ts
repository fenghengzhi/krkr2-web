import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseCue } from '../../src/formats/audio/cue.ts'
import { discVolumeTrack, readDiscVolumeLabel } from '../../src/formats/disc/volume-label.ts'
import { CddaDiscs } from '../../src/engine/storage/cdda.ts'
import type { ByteSource, Resource } from '../../src/engine/ports/storage.ts'
import type { CddaDisc } from '../../src/engine/ports/cdda.ts'

const image = (kind: string) => readFileSync(new URL(`../../out/verification/disc-volumes/${kind}.iso`, import.meta.url))
const sheet = (mode: string, filename: string, index = '00:00:00') =>
  `TITLE "An album title"\nFILE "${filename}" BINARY\nTRACK 01 ${mode}\nINDEX 01 ${index}\n`

test('reads independently authored ISO and Joliet labels from cooked and raw data tracks at their CUE INDEX', async () => {
  const plain = image('plain'), joliet = image('joliet')
  for (const [mode, stride, payload] of [['MODE1/2048', 2048, 0], ['MODE1/2352', 2352, 16],
    ['MODE2/2336', 2336, 8], ['MODE2/2352', 2352, 24]] as const) {
    for (const [bytes, expected] of [[plain, 'KRKR_PLAIN'], [joliet, 'KIRIKIRI_DISC']] as const) {
      const track = discVolumeTrack(parseCue(sheet(mode, 'data.bin', '00:02:00')))
      assert(track && track !== 'audio')
      const reads: number[] = [], source: ByteSource = {
        size: 900_000_000,
        async read(offset, length) {
          const sector = offset / stride - 150
          assert(Number.isInteger(sector) && sector >= 16 && sector < 20)
          assert(length < 128)
          reads.push(sector)
          const raw = Buffer.alloc(stride)
          if (stride === 2352) { raw.fill(255, 1, 11); raw[15] = mode.startsWith('MODE1') ? 1 : 2 }
          if (mode.startsWith('MODE2')) { raw[payload - 6] = 8; raw[payload - 2] = 8 }
          bytes.copy(raw, payload, sector * 2048, (sector + 1) * 2048)
          return raw.subarray(0, length)
        },
      }
      assert.equal(await readDiscVolumeLabel(source, track), expected)
      assert.deepEqual(reads, bytes === plain ? [16, 17, 18] : [16, 17, 18, 19],
        'Only ISO descriptors and the immediately adjoining bridge header are read')
    }
  }
})

test('uses the Joliet UCS-2 label ahead of a different primary label and respects the next track boundary', async () => {
  const bytes = Buffer.from(image('joliet')), primary = bytes.subarray(16 * 2048), secondary = bytes.subarray(17 * 2048)
  assert.equal(primary[0], 1); assert.equal(secondary[0], 2)
  const title = '桜のゲーム', field = secondary.subarray(40, 72)
  for (let i = 0; i < field.length / 2; i++) field.writeUInt16BE(i < title.length ? title.charCodeAt(i) : 32, i * 2)
  const track = discVolumeTrack(parseCue(sheet('MODE1/2048', 'game.iso')))
  assert(track && track !== 'audio')
  const source = { size: bytes.length, read: async (offset: number, length: number) => bytes.subarray(offset, offset + length) }
  assert.equal(await readDiscVolumeLabel(source, track), title)
  assert.equal(await readDiscVolumeLabel(source, { ...track, end: 17 }), 'KIRIKIRI_DISC')
  assert.equal(await readDiscVolumeLabel(source, { ...track, end: 16 }), undefined)
})

test('stock alphabetical drive lookup is independent of default playback order, missing discs and album titles', async () => {
  const files = new Map<string, Resource>(), add = (name: string, bytes: Uint8Array) =>
    files.set(name, { name, size: bytes.length, cacheToken: {}, read: async () => bytes })
  const text = new TextEncoder()
  add('disc.cue', text.encode('TITLE "Bogus album"\nFILE "track.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00'))
  add('track.wav', Uint8Array.of(1))
  add('unplayable.cue', text.encode(sheet('MODE1/2048', 'not-imported.iso')))
  add('mixed.cue', text.encode(sheet('MODE1/2048', 'mixed.iso')))
  let reads = 0
  const iso = image('joliet')
  files.set('mixed.iso', { name: 'mixed.iso', size: iso.length, cacheToken: {},
    read: async () => { throw new Error('unexpected whole disc read') },
    source: { size: iso.length, read: async (offset, length) => { reads++; return iso.subarray(offset, offset + length) } } })
  const resolver = (cues: string[], discs?: CddaDisc[]) => new CddaDiscs({ currentDirectory: '', cues: async () => cues,
    exact: async (path) => files.get(path), exists: async () => false, read: (file) => file.read(),
    decodeText: (bytes) => new TextDecoder().decode(bytes), checkpoint: async () => {} }, discs)
  const r = resolver([], [{ drive: 'H', cue: 'mixed.cue' }, { drive: 'E', cue: 'disc.cue', volumeLabel: 'Game Mk.2' },
    { drive: 'B', cue: 'missing.cue', volumeLabel: 'Game Mk.2' }, { drive: 'C', cue: 'disc.cue', volumeLabel: 'Game Mk.2' },
    { drive: 'A', cue: 'unplayable.cue' }])
  assert.equal(await r.searchVolume('game MK.2'), 'C')
  assert.equal(await r.searchVolume('KIRIKIRI_DISC'), 'H')
  const firstReads = reads
  assert(firstReads > 0)
  assert.equal(await r.searchVolume('kirikiri_disc'), 'H')
  assert.equal(reads, firstReads)
  add('mixed.iso', image('plain'))
  assert.equal(await r.searchVolume('kirikiri_disc'), '')
  assert.equal(await r.searchVolume('krkr_plain'), 'H')
  assert.equal(await resolver(['disc.cue']).searchVolume('Audio CD'), 'D')
  assert.equal(await resolver(['disc.cue']).searchVolume('Bogus album'), '')
  assert.equal(await resolver(['disc.cue', 'mixed.cue']).searchVolume('Audio CD'), '')
  files.delete('track.wav')
  assert.equal(await r.searchVolume('Game Mk.2'), '')
})
