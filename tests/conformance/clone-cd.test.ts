import assert from 'node:assert/strict'
import test from 'node:test'
import { cueTrackParts } from '../../src/formats/audio/cue.ts'
import { parseCloneCd } from '../../src/formats/disc/ccd.ts'
import { discVolumeTrack } from '../../src/formats/disc/volume-label.ts'

const toc = `[CloneCD]
Version=3
[Disc]
TocEntries=4
Sessions=1
DataTracksScrambled=0
[Session 1]
PreGapMode=1
[Entry 0]
Session=1
Point=0x01
Control=0x04
PLBA=0
[Entry 1]
Session=1
Point=0x02
Control=0x01
PLBA=20
[Entry 2]
Session=1
Point=0x03
Control=0x00
PLBA=40
[Entry 3]
Session=1
Point=0xa2
PLBA=60`

test('CloneCD keeps the recorded data boundary, audio pregap, emphasis and lead-out', async () => {
  const tracks = `
[TRACK 1]
MODE=1
INDEX 1=0
[TRACK 2]
MODE=0
INDEX 0=17
INDEX 1=20
[TRACK 3]
MODE=0
INDEX 0=38
INDEX 1=40`
  const image = { size: 64 * 2352, async read(at: number, length: number) {
    assert.deepEqual([at, length], [0, 16], 'only inspect the data track')
    return Uint8Array.of(0, ...Array<number>(10).fill(255), 0, 0, 2, 0, 2)
  } }
  const disc = await parseCloneCd(toc + tracks, '旅.img', image)
  assert.deepEqual(discVolumeTrack(disc), { file: '旅.img', first: 0, end: 17, layout: { bytes: 2352, payload: 24 } })
  assert.deepEqual(cueTrackParts(disc, 2), [
    { kind: 'file', file: 0, startFrame: 20, endFrame: 38, preEmphasis: true },
    { kind: 'file', file: 0, startFrame: 38, endFrame: 40 },
  ])
  assert.deepEqual(cueTrackParts(disc, 3), [{ kind: 'file', file: 0, startFrame: 40, endFrame: 60 }])
})

test('TOC-only CloneCD chooses the data mode from its first sector without reading audio', async () => {
  for (const mode of [1, 2]) {
    const reads: number[][] = []
    const disc = await parseCloneCd(toc.replace('Version=3', 'Version=2'), 'disc.img', {
      size: 60 * 2352, async read(at, length) {
        reads.push([at, length])
        return Uint8Array.of(0, ...Array<number>(10).fill(255), 0, 0, 2, 0, mode)
      },
    })
    assert.deepEqual(reads, [[0, 16]])
    assert.deepEqual(discVolumeTrack(disc), { file: 'disc.img', first: 0, end: 20,
      layout: { bytes: 2352, payload: mode === 1 ? 16 : 24 } })
    assert.equal(cueTrackParts(disc, 1), undefined)
  }
})
