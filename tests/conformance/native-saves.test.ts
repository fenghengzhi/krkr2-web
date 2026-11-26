import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { crc32 } from 'node:zlib'
import { openNativeSaveZip, readNativeSaves, writeNativeSaves } from '../../src/player/native-saves.ts'
import { SaveOverlay } from '../../src/engine/storage/save-overlay.ts'
import { MemorySaveStore, type SaveFile } from '../../src/engine/ports/saves.ts'
import { member, distributionZip } from '../helpers/deflated-distribution.ts'
import { centralRecords } from '../helpers/zip-fixtures.ts'

const bytes = (...values: number[]) => Uint8Array.from(values)
const file = (path: string, ...values: number[]) => ({ path, bytes: bytes(...values) })
function folderFile(path: string, values: Uint8Array<ArrayBuffer>) {
  const selected = new File([values], path.split('/').at(-1)!)
  Object.defineProperty(selected, 'webkitRelativePath', { value: path })
  return selected
}

test('desktop ZIP tools can extract every portable slot byte including Japanese names and bookmark trailers', async () => {
  const saves = [file('記録/スロット.bmp', 66, 77, 0, 255, 19, 0, 4, 0), file('global.ksd'), file('B/1.ksd', 1, 2)]
  const expected = saves.map(({ path, bytes }) => ({ path, bytes: bytes.slice() }))
  const pending = writeNativeSaves(saves)
  saves[0]!.bytes.fill(4)
  const zip = await pending
  assert.equal(zip.type, 'application/zip')
  // Python's independent standard reader checks header offsets, CRC, UTF-8
  // names and original contents. The repository's Node suite is hosted only.
  const actual = JSON.parse(execFileSync('python3', ['-c', [
    'import io, json, sys, zipfile',
    'with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:',
    ' assert z.testzip() is None',
    ' print(json.dumps([(i.filename, z.read(i).hex()) for i in z.infolist()]))',
  ].join('\n')], { input: Buffer.from(await zip.arrayBuffer()), encoding: 'utf8' }))
  assert.deepEqual(actual, expected.map(({ path, bytes }) => [path, Buffer.from(bytes).toString('hex')]))
  assert.deepEqual(await readNativeSaves([new File([zip], 'savedata.ZIP')], false), expected)
})

test('portable input accepts folders, loose slots, and raw-deflated desktop ZIPs without interpreting the save bytes', async () => {
  const layer = file('章/scene.ksd', 0, 127, 254), settings = file('config.ksd', 9)
  assert.deepEqual(await readNativeSaves([folderFile('Saved/章/scene.ksd', bytes(0,127,254)),
    folderFile('Saved/config.ksd', bytes(9))], true), [layer, settings])
  assert.deepEqual(await readNativeSaves([new File([bytes(1)], 'slot1.bmp'), new File([bytes(2)], 'slot2.kdt')], false),
    [file('slot1.bmp', 1), file('slot2.kdt', 2)])
  const packed = distributionZip([member(layer.path, layer.bytes), member(settings.path, settings.bytes)])
  assert.deepEqual(await readNativeSaves([new File([Uint8Array.from(packed)], 'export.zip')], false), [layer, settings])
  await assert.rejects(readNativeSaves([folderFile('A/a', bytes(1)), folderFile('B/b', bytes(2))], true), /完整的存档目录/)
  await assert.rejects(readNativeSaves([new File([], 'Slot.ksd'), new File([], 'slot.KSD')], false), /重复/)
  await assert.rejects(writeNativeSaves([file('one'), file('one/slot')]), /同名/)
  const bad = member('slot2.ksd', bytes(123, 45))
  const damaged = distributionZip([member('slot1.ksd', bytes(1)), { ...bad, crc: (bad.crc ^ 1) >>> 0 }])
  await assert.rejects(readNativeSaves([new File([Uint8Array.from(damaged)], 'saved.zip')], false), /CRC32/)
})

test('browse a desktop backup and read only the selected save directory relative to its root', async () => {
  const sibling = member('Game/Savedata.old/page.bmp', bytes(9))
  const files = [
    member('Game/Savedata/page.bmp', bytes(66, 77, 0, 255)),
    member('Game/Savedata/記録/global.ksd', bytes(3)),
    { ...sibling, crc: (sibling.crc ^ 1) >>> 0 },
    member('Readme.txt', 'backup'),
  ]
  const zip = new File([Uint8Array.from(distributionZip(files))], 'full-backup.zip')
  let cancelled = false
  const archive = await openNativeSaveZip(zip, () => { if (cancelled) throw new Error('session ended') })
  assert.deepEqual(archive.directory('').children, ['Game/'])
  assert.deepEqual(archive.directory('Game/').children, ['Game/Savedata.old/', 'Game/Savedata/'])
  assert.deepEqual(archive.directory('Game/Savedata/'),
    { children: ['Game/Savedata/記録/'], count: 2, size: 5, fits: true })
  assert.deepEqual(await archive.read('Game/Savedata/'), [file('page.bmp', 66, 77, 0, 255), file('記録/global.ksd', 3)])
  await assert.rejects(archive.read('Game/Savedata.old/'), /CRC32/)
  await assert.rejects(archive.read('Game/absent/'), /没有存档文件/)
  await assert.rejects(archive.read('Game/Savedata'), /目录/)
  cancelled = true
  await assert.rejects(archive.read('Game/Savedata/'), /session ended/)
})

test('a save subtree enforces relative collisions and its own byte budget before reading members', async () => {
  const large = member('Game/content.xp3', bytes(1))
  const zip = new File([Uint8Array.from(distributionZip([
    { ...large, size: 65 * 1024 * 1024 }, member('Game/Profile/slot', bytes(17)),
    member('Other/Profile/A', bytes(2)), member('Other/Profile/a', bytes(3)),
  ]))], 'two-editions.zip')
  const archive = await openNativeSaveZip(zip, () => {})
  assert.equal(archive.directory('').fits, false)
  await assert.rejects(archive.read(''), /64 MiB/)
  assert.deepEqual(await archive.read('Game/Profile/'), [file('slot', 17)])
  await assert.rejects(archive.read('Other/Profile/'), /重复/)
})

test('selecting a save folder in a backup larger than 96 MiB never reads the large game file in full', async () => {
  const template = distributionZip([member('Release/save/slot.ksd', bytes(4, 8)), member('Release/data.xp3', '')])
  const { central, records, end } = centralRecords(template), game = records[1]!
  const block = new Uint8Array(1024 * 1024), slab = new Blob([block]), count = 97, size = count * block.length
  let crc = 0
  for (let i = 0; i < count; i++) crc = crc32(block, crc)
  template.writeUInt16LE(0, game.local + 8)
  template.writeUInt16LE(0, game.at + 10)
  for (const start of [game.local + 14, game.at + 16]) {
    template.writeUInt32LE(crc, start)
    template.writeUInt32LE(size, start + 4)
    template.writeUInt32LE(size, start + 8)
  }
  template.writeUInt32LE(game.data + size, end + 16)
  const reads: number[] = []
  class Backup extends File {
    override slice(start?: number, stop?: number, type?: string): Blob {
      const result = super.slice(start, stop, type)
      reads.push(result.size)
      return result
    }
  }
  const backup = new Backup([Uint8Array.from(template.subarray(0, game.data)),
    ...Array<Blob>(count).fill(slab), Uint8Array.from(template.subarray(central))], 'release.zip')
  await assert.rejects(readNativeSaves([backup], false), /ZIP 超过大小限制/)
  const archive = await openNativeSaveZip(backup, () => {})
  assert.equal(archive.directory('Release/').fits, false)
  assert.deepEqual(await archive.read('Release/save/'), [file('slot.ksd', 4, 8)])
  assert(reads.length > 0 && Math.max(...reads) <= 65557)
})

test('native import publishes only a committed batch, preserving later writes across an aborted or successful import', async () => {
  const disk = new MemorySaveStore()
  let commit = (files: SaveFile[]) => disk.commit(files)
  const overlay = new SaveOverlay({ load: () => disk.load(), commit: (files) => commit(files), close: () => disk.close() })
  overlay.write('Game/Profile/Slot.A', bytes(5)); await overlay.flush()
  overlay.write('Game/outside', bytes(4))
  commit = async () => { throw new Error('Save storage unavailable') }
  await assert.rejects(overlay.import([file('slot.a', 55), file('slot.b', 66)], 'Game/Profile/'), /unavailable/)
  assert.deepEqual(overlay.export('game/profile/'), [file('Slot.A', 5)])
  assert.equal(overlay.pending, 1)
  await assert.rejects(overlay.import([file('slot.a/child', 2)], 'Game/Profile/'), /同名/)
  assert.equal(overlay.count, 2)
  assert.deepEqual(await disk.load(), [file('Game/Profile/Slot.A', 5)])

  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((r) => { enter = r }), gate = new Promise<void>((r) => { release = r })
  commit = async (files) => { enter(); await gate; await disk.commit(files) }
  const borrowed = Buffer.from([66])
  const importing = overlay.import([file('slot.a', 55), { path: 'slot.b', bytes: borrowed }, file('slot.c', 77)], 'Game/Profile/')
  borrowed.fill(0)
  await entered
  assert.deepEqual(overlay.export('Game/Profile/'), [file('Slot.A', 5)])
  assert.throws(() => overlay.write('Game/Profile/slot.c/child', bytes(3)), /同名/)
  overlay.write('Game/Profile/Slot.A', bytes(99))
  overlay.write('Game/Profile/SLOT.C', bytes(88))
  const flushing = overlay.flush()
  release(); await importing; await flushing
  assert.deepEqual(overlay.export('game/profile/').sort((a,b) => a.path < b.path ? -1 : 1),
    [file('Slot.A', 99), file('slot.b', 66), file('slot.c', 88)])
  assert.deepEqual(await disk.load(), [file('Game/Profile/Slot.A', 99), file('Game/outside', 4), file('Game/Profile/slot.b', 66), file('Game/Profile/slot.c', 88)])
  assert.equal(overlay.pending, 0)
  const queued = overlay.import([file('slot.a', 10)], 'Game/Profile/')
  overlay.write('Game/Profile/Slot.A', bytes(11))
  await queued; await overlay.flush()
  assert.deepEqual(overlay.get('Game/Profile/Slot.A'), bytes(11))
  assert.deepEqual((await disk.load()).find((entry) => entry.path.endsWith('/Slot.A'))!.bytes, bytes(11))
})

test('replacing a large original slot and adding its successor uses the final batch size regardless of order', async () => {
  const old = new Uint8Array(33 * 1024 * 1024); old[0] = 41
  let committed: string[] = []
  const overlay = new SaveOverlay({ load: async () => [{ path: 'savedata/old', bytes: old }],
    async commit(files) { committed = files.map((v) => v.path) }, close() {} })
  await overlay.initialize()
  await overlay.import([{ path: 'new', bytes: old }, file('OLD', 7)], 'savedata/')
  assert.deepEqual(committed, ['savedata/new', 'savedata/old'])
  assert.equal(overlay.size('savedata/new'), old.length); assert.deepEqual(overlay.get('savedata/old'), bytes(7))
  assert.equal(overlay.pending, 0)
})

test('copying between editions keeps the latest target slot from another session and preserves nested names', async () => {
  const disk = new MemorySaveStore()
  const destination = 'New/Profile/'
  await disk.commit([file(destination + 'Slot.DAT', 1)])
  const first = new SaveOverlay(disk), second = new SaveOverlay(disk)
  await first.initialize(); await second.initialize()
  second.write(destination + 'Slot.DAT', bytes(99))
  await second.flush()
  const incoming = [file('slot.dat', 7), file('章/notes.txt', 3)]
  assert.deepEqual(await first.copy(incoming, destination, false, () => {}), { copied: 1, kept: 1 })
  assert.deepEqual(first.export(destination), [file('Slot.DAT', 99), file('章/notes.txt', 3)])
  assert.deepEqual(await first.copy(incoming, destination, false, () => {}), { copied: 0, kept: 2 })
  assert.deepEqual(await first.copy(incoming, destination, true, () => {}), { copied: 2, kept: 0 })
  assert.deepEqual(await disk.load(), [file(destination + 'Slot.DAT', 7), file(destination + '章/notes.txt', 3)])
})

test('a failed version copy leaves player writes pending and preserves disk and memory', async () => {
  const disk = new MemorySaveStore()
  await disk.commit([file('saves/chapters/slot', 2)])
  const overlay = new SaveOverlay(disk)
  await overlay.initialize()
  overlay.write('settings', bytes(17))
  await assert.rejects(overlay.copy([file('new-slot', 1), file('chapters', 7)], 'saves/', true, () => {}), /同名/)
  await assert.rejects(overlay.copy([file('new-slot', 1)], 'saves/', false, () => { throw new Error('resumed') }), /resumed/)
  assert.deepEqual(await disk.load(), [file('saves/chapters/slot', 2)])
  assert.deepEqual(overlay.export('saves/'), [file('chapters/slot', 2)])
  assert.equal(overlay.pending, 1)
})
