import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeSaveDrop, nativeSaveDropFiles } from '../../src/app/native-save-drop.ts'
import { readNativeSaveBlobs } from '../../src/player/native-saves.ts'
import { SaveOverlay } from '../../src/engine/storage/save-overlay.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import type { SessionClient } from '../../src/player/session-client.ts'

test('a dropped savedata directory strips only its outer name and overwrites the current data directory atomically', async () => {
  const slot = new Blob([new Uint8Array([66, 77, 255, 254, 7])]), notes = new Blob(['chapter 7']), rawZip = new Blob(['opaque game-owned slot bytes']),
    selected = nativeSaveDropFiles({ roots: [{ name: 'savedata', kind: 'directory' }], entries: [
      { root: 0, path: '', kind: 'directory' }, { root: 0, path: 'Empty', kind: 'directory' },
      { root: 0, path: 'Slot.bmp', kind: 'file', source: slot },
      { root: 0, path: '記録/notes.txt', kind: 'file', source: notes },
      { root: 0, path: 'game-slot.zip', kind: 'file', source: rawZip },
    ] }), store = new MemorySaveStore(), saves = new SaveOverlay(store)
  assert.equal(selected.directory, true)
  assert.equal(selected.files[0]!.blob, slot)
  assert.deepEqual(selected.files.map((file) => file.path), ['Slot.bmp', '記録/notes.txt', 'game-slot.zip'])
  saves.write('Current/Profile/slot.BMP', new Uint8Array([99]))
  saves.write('Other/Profile/slot.BMP', new Uint8Array([44]))
  await saves.flush()
  await saves.import(await readNativeSaveBlobs(selected.files), 'Current/Profile/')
  assert.deepEqual(saves.get('Current/Profile/slot.BMP'), new Uint8Array([66, 77, 255, 254, 7]))
  assert.deepEqual(saves.get('Other/Profile/slot.BMP'), new Uint8Array([44]))
  assert.equal(saves.get('Current/Profile/savedata/Slot.bmp'), undefined)
  assert.deepEqual(saves.get('Current/Profile/game-slot.zip'), new TextEncoder().encode('opaque game-owned slot bytes'))
  assert.deepEqual((await store.load()).map((file) => file.path).sort(), [
    'Current/Profile/game-slot.zip', 'Current/Profile/slot.BMP', 'Current/Profile/記録/notes.txt', 'Other/Profile/slot.BMP',
  ])
})

test('ambiguous loose slots and mixed roots reject the complete drop before reading any save bytes', async () => {
  let reads = 0
  const blob = new Blob([new Uint8Array([7])])
  blob.arrayBuffer = async () => { reads++; return new Uint8Array([7]).buffer }
  const files = nativeSaveDropFiles({ roots: [{ name: 'Slot.BMP', kind: 'file' }, { name: 'slot.bmp', kind: 'file' }], entries: [
    { root: 0, path: '', kind: 'file', source: blob }, { root: 1, path: '', kind: 'file', source: blob },
  ] }).files
  await assert.rejects(readNativeSaveBlobs(files), /重复/)
  await assert.rejects(readNativeSaveBlobs([{ path: 'notes', blob }, { path: 'notes/chapter.txt', blob }]), /同名/)
  assert.throws(() => nativeSaveDropFiles({ roots: [{ name: 'Savedata', kind: 'directory' }, { name: 'other.bmp', kind: 'file' }],
    entries: [{ root: 0, path: '', kind: 'directory' }, { root: 1, path: '', kind: 'file', source: blob }] }), /完整存档目录/)
  assert.equal(reads, 0)
})

test('resuming or replacing the game during a held file read prevents publication and a fresh drop can succeed', async () => {
  let release!: (value: ArrayBuffer) => void, entered!: () => void, active = true
  const started = new Promise<void>((resolve) => { entered = resolve }), gate = new Promise<ArrayBuffer>((resolve) => { release = resolve }),
    blob = new Blob([new Uint8Array([7])]), reason = new Error('game resumed')
  blob.arrayBuffer = () => { entered(); return gate }
  const pending = readNativeSaveBlobs([{ path: 'slot.bmp', blob }], () => { if (!active) throw reason }), rejected = assert.rejects(pending, (error) => error === reason)
  await started; active = false; release(new Uint8Array([7]).buffer)
  await rejected
  assert.deepEqual(await readNativeSaveBlobs([{ path: 'slot.bmp', blob: new Blob([new Uint8Array([8])]) }]),
    [{ path: 'slot.bmp', bytes: new Uint8Array([8]) }])
})

test('the save card retires a pending old-session drop and imports a later drop into its own paused session', { timeout: 5000 }, async () => {
  const writes: string[] = [], errors: unknown[] = [], root = Object.assign(new EventTarget(), { dataset: {} }),
    first = { async importSaves() { writes.push('first') } } as unknown as SessionClient,
    second = { async importSaves() { writes.push('second') } } as unknown as SessionClient
  let current = first, action: Promise<void> | undefined, entered!: () => void, release!: (bytes: ArrayBuffer) => void,
    imported!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve }), gate = new Promise<ArrayBuffer>((resolve) => { release = resolve }),
    completed = new Promise<void>((resolve) => { imported = resolve }), held = new File([new Uint8Array([7])], 'slot.bmp')
  held.arrayBuffer = () => { entered(); return gate }
  const card = createNativeSaveDrop(root as unknown as HTMLElement, {
    run(work) { action = work(current, () => {}) }, openZip() { throw new Error('Unexpected ZIP selection') },
    imported, status() {}, error(error) { errors.push(error) },
  })
  const drop = (file: File) => {
    const event = new Event('drop', { cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { items: [], files: [file], types: ['Files'] } })
    root.dispatchEvent(event)
    assert.equal(event.defaultPrevented, true)
  }
  try {
    card.update(first, false); drop(held)
    await started
    const rejected = assert.rejects(action!, /已取消/)
    // update(undefined) is also used by Resume; replacing it with another
    // paused session must never make this older selection valid again.
    card.update(undefined, false); current = second; card.update(second, false)
    release(new Uint8Array([7]).buffer)
    await rejected
    assert.deepEqual(writes, [])
    drop(new File([new Uint8Array([8])], 'slot.bmp'))
    await completed; await action
    assert.deepEqual(writes, ['second'])
    assert.deepEqual(errors, [])
  } finally { release(new Uint8Array([7]).buffer); card.dispose() }
})
