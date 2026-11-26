import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { discBootInput } from '../helpers/disc-boot.ts'
import { headless } from '../helpers/headless.ts'

// A preceding audio track occupies exactly 150 physical sectors. The game
// image starts at TRACK 02 INDEX 01, and every Mode 1 sector has a 16-byte header.
function pressing(iso: Buffer, lengths: number[]): Resource[] {
  const stride = 2352, start = 150, size = (start + iso.length / 2048) * stride
  const raw = { size, async read(offset: number, length: number) {
    assert(offset >= start * stride && offset + length <= size)
    assert(length <= 65536)
    lengths.push(length)
    const bytes = Buffer.alloc(length)
    for (let at = 0; at < length;) {
      const address = offset + at, sector = Math.floor(address / stride), inside = address % stride
      const block = Buffer.alloc(stride)
      block.fill(255, 1, 11); block[15] = 1
      const data = (sector - start) * 2048
      iso.copy(block, 16, data, data + 2048)
      const n = Math.min(stride - inside, length - at)
      block.copy(bytes, at, inside, inside + n); at += n
    }
    return bytes
  } }
  const cue = Buffer.from('FILE "pressing.bin" BINARY\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 MODE1/2352\nINDEX 01 00:02:00\n')
  return [{ name: 'media/CD.cue', size: cue.length, read: async () => cue },
    { name: 'media/pressing.bin', size, source: raw, read: async () => { throw new Error('Unexpected full disc read') } }]
}

test('the VM opens a mixed-mode pressing at its data-track INDEX and writes progress outside the disc', async (t) => {
  const lengths: number[] = [], files = pressing(discBootInput(false).files[0]!.buffer, lengths)
  const reader = createSessionArchiveReader(); t.after(() => reader.dispose())
  const mount = await prepareProject(files, { mode: 'collection' }, reader, async () => {})
  assert.equal(mount.project?.bootDisc, 'media/CD.cue'); assert(lengths.length > 0)
  const { session } = await headless({}, { project: mount.project })
  session.mount(mount.resources)
  try {
    const result = await session.evaluate(`(function(){
     var drive=Storages.searchCD("KRKR_STORY"),scene=Scripts.evalStorage(drive+":/Routes/開幕.tjs");
     [scene].save(System.dataPath+"disc-slot.txt");
     var locked=0;try{["changed"].save(drive+":/Routes/開幕.tjs");}catch(e){locked++;}
     return [drive,System.exePath,Storages.getFullPath("./"),Storages.getPlacedPath("startup.tjs"),System.dataPath,
      [].load(System.dataPath+"disc-slot.txt")[0],locked,Scripts.evalStorage(drive+":/Routes/開幕.tjs")].join("|");})()`)
    assert.equal(result, 'D|file://./d/discgame/|file://./d/discgame/data.xp3>|file://./d/discgame/data.xp3>startup.tjs|game://./savedata/|42|1|42')
    assert(session.exportSaves().some((file) => file.path === 'savedata/disc-slot.txt'))
  } finally { await session.stop() }
})
