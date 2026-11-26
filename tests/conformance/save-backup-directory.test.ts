import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeBackup, decodeBackup, openSaveBackup } from '../../src/player/save-backup.ts'
import { SaveOverlay } from '../../src/engine/storage/save-overlay.ts'
import { MemorySaveStore, type SaveFile } from '../../src/engine/ports/saves.ts'

const oldId = 'game-' + 'a'.repeat(64), currentId = 'game-' + 'b'.repeat(64)
const file = (path: string, ...bytes: number[]): SaveFile => ({ path, bytes: Uint8Array.from(bytes) })
const document = (files: { path: string; base64: string }[]) => new File([JSON.stringify({
  format: 'krkr2-web-saves', version: 1, gameId: oldId, files,
})], 'old-browser-backup.json')

test('explicit backup directory migration retains the old identity and copies only the selected subtree into current saves', async () => {
  const source = [file('Old/Profile/Slot.bmp', 66, 77, 255, 254, 7), file('Old/Profile/記録/notes.txt', 7),
    file('Old/Profile.old/Slot.bmp', 99), file('Old/outside.txt', 17)],
    backup = new File([encodeBackup(oldId, source)], 'old.json'), archive = await openSaveBackup(backup),
    store = new MemorySaveStore(), target = new SaveOverlay(store)
  await assert.rejects(decodeBackup(currentId, backup), /另一组游戏文件/)
  assert.deepEqual(await decodeBackup(oldId, backup), source)
  assert.equal(archive.gameId, oldId)
  assert.deepEqual(archive.directory('').children, ['Old/'])
  assert.deepEqual(archive.directory('Old/').children, ['Old/Profile.old/', 'Old/Profile/'])
  assert.deepEqual(archive.directory('Old/Profile/'), { children: ['Old/Profile/記録/'], count: 2, size: 6, fits: true })
  const selected = await archive.read('Old/Profile/')
  assert.deepEqual(selected, [file('Slot.bmp', 66, 77, 255, 254, 7), file('記録/notes.txt', 7)])
  target.write('New/SaveData/slot.BMP', Uint8Array.from([99])); target.write('New/outside.txt', Uint8Array.from([44]))
  await target.flush(); await target.import(selected, 'New/SaveData/')
  assert.deepEqual(target.get('New/SaveData/slot.BMP'), source[0]!.bytes)
  assert.deepEqual(target.get('New/outside.txt'), Uint8Array.from([44]))
  assert.equal(target.get('New/SaveData/Old/Profile/Slot.bmp'), undefined)
  assert.equal(target.get('New/SaveData/outside.txt'), undefined)
  assert.deepEqual(await decodeBackup(oldId, backup), source, 'Migration never changes the original backup')
})

test('a selected conflicting directory or an invalid source path leaves all current slot bytes unchanged', async () => {
  const store = new MemorySaveStore(), target = new SaveOverlay(store)
  target.write('Current/slot.bmp', Uint8Array.from([99])); await target.flush()
  const backup = document([{ path: 'Old/Profile/slot.bmp', base64: 'Bw==' }, { path: 'Old/Profile/SLOT.BMP', base64: 'CA==' }]),
    archive = await openSaveBackup(backup)
  await assert.rejects(async () => target.import(await archive.read('Old/Profile/'), 'Current/'), /重复/)
  const invalid = document([{ path: 'Old/Profile/slot.bmp', base64: 'Bw==' }, { path: 'C:\\Old\\outside.txt', base64: 'CA==' }])
  await assert.rejects(async () => target.import(await (await openSaveBackup(invalid)).read('Old/Profile/'), 'Current/'), /Invalid resource path/)
  for (const path of ['Old/Profile/', 'Old/Profile\\'])
    await assert.rejects(openSaveBackup(document([{ path, base64: 'Bw==' }])), /备份文件路径/)
  assert.deepEqual(target.export(), [file('Current/slot.bmp', 99)])
  assert.deepEqual(await store.load(), [file('Current/slot.bmp', 99)])
})

test('older relative path spellings and atob-compatible Base64 preserve exact selected bytes and expose collisions after normalization', async () => {
  const backup = document([{ path: '.\\Old\\Profiles\\slot.bmp', base64: ' /wA=\r\n' },
    { path: 'Old/Profiles/notes/../note.txt', base64: 'Bw' }, { path: 'Old/Profiles/empty', base64: '' },
    { path: '?/章/終幕🌙.kdt', base64: '//4HAA==' }]),
    archive = await openSaveBackup(backup)
  assert.deepEqual(archive.directory('Old/Profiles/'), { children: [], count: 3, size: 3, fits: true })
  assert.deepEqual(await archive.read('Old/Profiles/'), [file('slot.bmp', 255, 0), file('note.txt', 7), file('empty')])
  assert.deepEqual(archive.directory('?/').children, ['?/章/'])
  assert.deepEqual(await archive.read('?/章/'), [file('終幕🌙.kdt', 255, 254, 7, 0)])
  const aliases = await openSaveBackup(document([{ path: 'Old\\Profiles\\slot.bmp', base64: 'Bw==' },
    { path: 'Old/Profiles/slot.bmp', base64: 'CA==' }]))
  await assert.rejects(aliases.read('Old/Profiles/'), /重复/)
  await assert.rejects(openSaveBackup(document([{ path: 'Old/slot', base64: 'B' }])), /文件编码/)
  await assert.rejects(archive.read('Old/Absent/'), /没有存档文件/)
})

test('a resumed or replaced session invalidates both a pending backup open and an already indexed directory read', async () => {
  let release!: (text: string) => void, entered!: () => void, live = true
  const started = new Promise<void>((resolve) => { entered = resolve }), gate = new Promise<string>((resolve) => { release = resolve }),
    source = document([{ path: 'Old/slot.bmp', base64: 'Bw==' }]), body = await source.text(), reason = new Error('current session changed')
  source.text = () => { entered(); return gate }
  const active = () => { if (!live) throw reason }, opening = openSaveBackup(source, active), rejected = assert.rejects(opening, (error) => error === reason)
  await started; live = false; release(body); await rejected
  live = true
  const archive = await openSaveBackup(new File([body], 'again.json'), active)
  live = false
  assert.throws(() => archive.directory('Old/'), (error) => error === reason)
  await assert.rejects(archive.read('Old/'), (error) => error === reason)
})
