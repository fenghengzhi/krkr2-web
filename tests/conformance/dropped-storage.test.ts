import test from 'node:test'
import assert from 'node:assert/strict'
import { DropStorage } from '../../src/engine/storage/drop.ts'
import { dropLimits, type DropResourceTree } from '../../src/engine/ports/storage-drop.ts'
import { StorageResolver } from '../../src/engine/storage/resolver.ts'
import { SaveOverlay } from '../../src/engine/storage/save-overlay.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import { archiveReader } from '../../src/backends/files/archive-reader.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import type { ByteSource } from '../../src/engine/ports/storage.ts'

const source = (value = 'text'): ByteSource => new BlobSource(new Blob([value]))
const fileTree = (name = 'same.txt', reader = source()): DropResourceTree => ({ roots: [{ name, kind: 'file' }],
  entries: [{ root: 0, path: '', kind: 'file', source: reader }] })
const gate = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve }); return { promise, release } }
function fixture(checkpoint = async () => {}) {
  const resolver = new StorageResolver('', true, archiveReader), saved = new SaveOverlay(new MemorySaveStore(),
    () => resolver.invalidateSearch(), (path) => resolver.assertWritable(path)),
    storage = new DropStorage(resolver, () => saved.list().map((file) => file.name), checkpoint)
  return { resolver, saved, storage, close() { storage.dispose(); resolver.clear(); resolver.dispose(); saved.close() } }
}

test('drop atomically mounts independent same-name files and real empty directories without eager reads', async () => {
  const f = fixture(), base = source('first'); let reads = 0
  f.resolver.mount([{ name: '.KRKR-DROP-1/occupied', size: 0, read: async () => new Uint8Array() }])
  f.saved.write('.krkr-drop-2/occupied', new Uint8Array([9]))
  try {
    const names = await f.storage.commit({ roots: [{ name: 'same.txt', kind: 'file' }, { name: 'same.txt', kind: 'file' }, { name: 'Folder', kind: 'directory' }], entries: [
      { root: 0, path: '', kind: 'file', source: { size: base.size, read: async (offset, length) => { reads++; return base.read(offset, length) } } },
      { root: 1, path: '', kind: 'file', source: source('second') },
      { root: 2, path: '', kind: 'directory' }, { root: 2, path: 'Empty', kind: 'directory' },
    ] }, () => true)
    assert.deepEqual(names, ['game://./.krkr-drop-3/0/same.txt', 'game://./.krkr-drop-3/1/same.txt', 'game://./.krkr-drop-3/2/Folder/'])
    assert.equal(reads, 0)
    const first = await f.resolver.findAsync(names[0]!), second = await f.resolver.findAsync(names[1]!)
    assert.notEqual(first!.cacheToken, second!.cacheToken)
    assert.equal(new TextDecoder().decode(await first!.read()), 'first')
    assert.equal(new TextDecoder().decode(await second!.read()), 'second')
    assert.deepEqual((await f.resolver.listDirectory(names[2]!)).directories, ['.krkr-drop-3/2/Folder/Empty/'])
    assert.deepEqual(await f.resolver.listDirectory(names[2]! + 'Empty/'), { name: '.krkr-drop-3/2/Folder/Empty/', entries: [], directories: [] })
  } finally { f.close() }
})

test('invalid batches publish no file or directory and a later valid batch can recover', async () => {
  const f = fixture()
  try {
    for (const bad of [
      { roots: [{ name: '../escape', kind: 'file' }], entries: [{ root: 0, path: '', kind: 'file', source: source() }] },
      { roots: [{ name: 'dir', kind: 'directory' }], entries: [{ root: 0, path: 'child', kind: 'file', source: source() }] },
      { roots: [{ name: 'dir', kind: 'directory' }], entries: [{ root: 0, path: '', kind: 'directory' }, { root: 0, path: 'missing/child', kind: 'file', source: source() }] },
      { roots: [{ name: 'file', kind: 'file' }], entries: [{ root: 0, path: '', kind: 'file', source: source() }, { root: 0, path: '', kind: 'file', source: source() }] },
    ] as DropResourceTree[]) {
      await assert.rejects(f.storage.commit(bad, () => true))
      assert.equal(f.resolver.count, 0)
      assert.deepEqual(await f.resolver.listDirectory(''), { name: '', entries: [], directories: [] })
    }
    const accepted = await f.storage.commit(fileTree(), () => true)
    assert.equal(accepted[0], 'game://./.krkr-drop-1/0/same.txt')
  } finally { f.close() }
})

test('a save racing staged metadata rejects the entire drop and retains the save', { timeout: 30000 }, async () => {
  const entered = gate(), release = gate(), f = fixture(async () => { entered.release(); await release.promise }),
    pending = f.storage.commit(fileTree(), () => true)
  try {
    await entered.promise
    f.saved.write('.krkr-drop-1/0/same.txt', new Uint8Array([7]))
    release.release()
    await assert.rejects(pending, /collided/)
    assert.equal(f.resolver.count, 0)
    assert.deepEqual(f.saved.get('.krkr-drop-1/0/same.txt'), new Uint8Array([7]))
    assert.equal(f.storage.inspect().pendingBatches, 0)
  } finally { release.release(); await Promise.allSettled([pending]); f.close() }
})

test('the final save sink rejects case/dot/ancestor shadowing and import validates every entry before changing any save', async () => {
  const f = fixture()
  try {
    f.saved.write('old.sav', new Uint8Array([1]))
    const [directory] = await f.storage.commit({ roots: [{ name: 'Empty', kind: 'directory' }], entries: [{ root: 0, path: '', kind: 'directory' }] }, () => true)
    for (const name of ['.krkr-drop-1', '.krkr-drop-1/0/Empty/new.sav', '.KRKR-DROP-1/other.sav', 'x/../.krkr-drop-1/anything'])
      assert.throws(() => f.saved.write(name, new Uint8Array([8])), /read-only/)
    await assert.rejects(f.saved.import([{ path: 'old.sav', bytes: new Uint8Array([2]) },
      { path: 'fresh.sav', bytes: new Uint8Array([3]) }, { path: '.KRKR-DROP-1/shadow.sav', bytes: new Uint8Array([4]) }]), /read-only/)
    assert.deepEqual(f.saved.get('old.sav'), new Uint8Array([1]))
    assert.equal(f.saved.get('fresh.sav'), undefined)
    assert.deepEqual(await f.resolver.listDirectory(directory!), { name: '.krkr-drop-1/0/Empty/', entries: [], directories: [] })
  } finally { f.close() }
})

test('dropped archives use the shared lazy reader and never add naked collection aliases', async () => {
  const f = fixture(), bytes = Uint8Array.from(xp3Fixture({ 'member.tjs': '42' }).bytes), base = new BlobSource(new Blob([bytes.buffer])); let reads = 0
  try {
    const [name] = await f.storage.commit(fileTree('pack.xp3', { size: base.size,
      async read(offset, length) { reads++; return base.read(offset, length) } }), () => true)
    assert.equal(reads, 0)
    assert.equal(await f.resolver.lookupAsync('member.tjs'), undefined)
    assert.equal(reads, 0)
    const member = await f.resolver.findAsync(name! + '>member.tjs')
    assert.equal(new TextDecoder().decode(await member!.read()), '42')
    assert(reads > 0)
    f.resolver.addAutoPath(name! + '>')
    assert.equal((await f.resolver.lookupAsync('member.tjs'))?.name, '.krkr-drop-1/0/pack.xp3>member.tjs')
  } finally { f.close() }
})

test('large dropped sources remain ranged and declared Session budgets reject additional sources without reading bytes', async () => {
  const f = fixture(); let reads = 0
  try {
    const [name] = await f.storage.commit(fileTree('large.bin', { size: dropLimits.sourceBytes,
      async read(_offset, length) { reads++; return new Uint8Array(length).fill(7) } }), () => true),
      resource = await f.resolver.findAsync(name!)
    assert.equal(reads, 0)
    await assert.rejects(resource!.read(), /complete-read budget/)
    assert.deepEqual(await resource!.source!.read(dropLimits.sourceBytes - 4, 4), new Uint8Array([7,7,7,7]))
    await assert.rejects(f.storage.commit(fileTree('extra'), () => true), /Session budget/)
    assert.equal(f.resolver.count, 1)
    assert.equal(reads, 1)
  } finally { f.close() }
})

test('Stop settles pending readers but their original IO byte reservations remain until providers finish', { timeout: 30000 }, async () => {
  const f = fixture(), release = gate(), source: ByteSource = { size: 64 * 1024 * 1024,
    async read() { await release.promise; throw new Error('late provider failure') } }
  try {
    const [name] = await f.storage.commit(fileTree('large.bin', source), () => true), resource = await f.resolver.findAsync(name!),
      first = resource!.source!.read(0, source.size), second = resource!.source!.read(0, source.size),
      a = assert.rejects(first, /disposed/), b = assert.rejects(second, /disposed/)
    await assert.rejects(resource!.source!.read(0, 1), /read budget/)
    assert.equal(f.storage.inspect().pendingReadBytes, 128 * 1024 * 1024)
    f.storage.dispose(); await Promise.all([a, b])
    assert.equal(f.storage.inspect().pendingReadBytes, 128 * 1024 * 1024)
    release.release(); await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(f.storage.inspect().pendingReads, 0)
    assert.equal(f.storage.inspect().pendingReadBytes, 0)
  } finally { release.release(); f.close() }
  const reentrant = fixture()
  try {
    const [name] = await reentrant.storage.commit(fileTree('reentrant.bin', { size: 1,
      read() { reentrant.storage.dispose(); return Promise.reject(new Error('provider rejected after synchronous Stop')) },
    }), () => true), resource = await reentrant.resolver.findAsync(name!)
    await assert.rejects(resource!.source!.read(0, 1), /disposed/)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(reentrant.storage.inspect().pendingReads, 0)
    assert.equal(reentrant.storage.inspect().pendingReadBytes, 0)
  } finally { reentrant.close() }
})

test('Window revocation and Stop during staged metadata leave no namespace and no retained batch', { timeout: 30000 }, async () => {
  for (const stop of [false, true]) {
    const entered = gate(), release = gate(), f = fixture(async () => { entered.release(); await release.promise }); let valid = true
    const pending = f.storage.commit(fileTree(), () => valid), rejected = assert.rejects(pending, /available|disposed/)
    try {
      await entered.promise
      valid = false
      if (stop) f.storage.dispose()
      else release.release()
      await rejected
      assert.equal(f.resolver.count, 0)
      assert.equal(f.storage.inspect().pendingBatches, 0)
      assert.equal(f.storage.inspect().batches, 0)
    } finally { release.release(); await rejected; f.close() }
  }
})
