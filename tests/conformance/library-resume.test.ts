import assert from 'node:assert/strict'
import test from 'node:test'
import { copyLibraryFile, hashBlock, type LibraryCopyCheckpoint, type LibraryWriter } from '../../src/backends/files/opfs-library.ts'
import { LIBRARY_BLOCK_BYTES as block, type LibraryRecord, type LibraryDownloadRecord } from '../../src/player/library/records.ts'
import { LibraryService } from '../../src/player/library/service.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { gameIdentity } from '../../src/player/game-identity.ts'
import { httpServer } from '../helpers/http-server.ts'

/** A fresh handle per attempt, with only flush() surviving abrupt closure. */
function disk(size: number) {
  const durable = new Uint8Array(size)
  let committedSize = 0
  return { durable, open() {
    const buffer = durable.slice()
    let length = committedSize
    const handle: LibraryWriter = {
      truncate(end) { if (end < length) buffer.fill(0, end, length); length = end },
      getSize() { return length },
      write(bytes, { at }) {
        const n = Math.min(bytes.length, 65536)
        buffer.set(bytes.subarray(0, n), at); length = Math.max(length, at + n)
        return n
      },
      read(bytes, { at }) {
        const n = Math.min(bytes.length, 8192, Math.max(0, length - at))
        bytes.set(buffer.subarray(at, at + n))
        return n
      },
      flush() { durable.set(buffer); committedSize = length },
      close() {},
    }
    return handle
  } }
}

test('a restarted download rechecks disk blocks, repairs corrupted bytes and fetches only remaining ranges', async () => {
  const bytes = Uint8Array.from({ length: 3 * block + 7 }, (_, at) => (at >>> 20) + 1),
    file = disk(bytes.length), saved = new Map<number, string>(), reads: number[] = []
  let failure = true
  const source = { path: 'game.xp3', remoteIdentity: 'pinned', source: { size: bytes.length, async read(at: number, length: number) {
    reads.push(at)
    if (failure && at === 2 * block) throw new Error('connection lost')
    return bytes.slice(at, at + length)
  } } }
  const checkpoint: LibraryCopyCheckpoint = {
    hashes: saved, async save(index, hash) {
      // A durable checkpoint always describes already-flushed bytes.
      assert.equal(await hashBlock(file.durable.slice(index * block, (index + 1) * block)), hash)
      saved.set(index, hash)
    },
  }
  const signal = new AbortController().signal
  await assert.rejects(copyLibraryFile(source, file.open(), signal, () => {}, checkpoint), /connection lost/)
  assert.deepEqual([...saved.keys()], [0, 1])
  file.durable[block + 3] = 99
  failure = false; reads.length = 0
  let reused = 0
  const result = await copyLibraryFile(source, file.open(), signal, (n, fromDisk) => { if (fromDisk) reused += n }, checkpoint)
  assert.equal(reused, block)
  assert.deepEqual(reads, [block, 2 * block, 3 * block])
  assert.deepEqual(file.durable, bytes)
  assert.deepEqual(result.hashes, [...saved.values()])
  reads.length = 0; reused = 0
  await copyLibraryFile(source, file.open(), signal, (n, fromDisk) => { if (fromDisk) reused += n }, checkpoint)
  assert.equal(reused, bytes.length); assert.deepEqual(reads, [])
})

test('durable bytes without a committed hash and unchecked local inputs are fetched again', async () => {
  const bytes = Uint8Array.of(10, 20, 30), file = disk(bytes.length), saved = new Map<number, string>()
  let reads = 0
  const source = { path: 'data', source: { size: bytes.length, async read() { reads++; return bytes.slice() } } }
  const signal = new AbortController().signal
  await assert.rejects(copyLibraryFile(source, file.open(), signal, () => {}, {
    hashes: saved, async save() { throw new Error('checkpoint was interrupted') },
  }), /checkpoint was interrupted/)
  assert.deepEqual(file.durable, bytes); assert.equal(reads, 1)
  await copyLibraryFile(source, file.open(), signal, () => {}, { hashes: saved, async save(n, hash) { saved.set(n, hash) } })
  assert.equal(reads, 2)
  bytes[0] = 42
  await copyLibraryFile(source, file.open(), signal, () => {})
  assert.equal(reads, 3); assert.deepEqual(file.durable, bytes)
})

test('reselecting mixed game inputs reuses the pinned remote block and recopies unsampled local edits', async () => {
  const local = new Uint8Array(200000), remote = Buffer.alloc(block + 23, 9)
  let interrupt = true
  const server = await httpServer({ '/voice': { bytes: remote, etag: '"one"', intercept(req, res) {
    if (!interrupt || !req.headers.range?.startsWith('bytes=1048576-')) return false
    res.writeHead(503).end(); return true
  } } })
  const url = server.url + '/voice', remoteIdentity = JSON.stringify([url, url, '"one"'])
  const entries = new Map<number, ReturnType<typeof disk>>(), hashes = new Map<number, string>()
  let pending: LibraryDownloadRecord | undefined, published: LibraryRecord | undefined
  // Storage transactions and real cross-tab locks are exercised in the
  // browser. This isolates the mixed-source policy through importGame itself.
  const index: ConstructorParameters<typeof LibraryService>[0] = {
    async catalog() { return { games: published ? [published] : [], downloads: pending ? [pending] : [] } },
    async get() { assert(published); return published },
    async startDownload(record, request) { assert.equal(request, undefined); pending = record },
    async requestFor() { throw new Error('Supply local files again') },
    async hashes(_id, file) { assert.equal(file, 1); return new Map(hashes) },
    async saveHash(_id, file, index, hash) { assert.equal(file, 1); hashes.set(index, hash) },
    async put(record) { published = record; pending = undefined; hashes.clear() },
    async remove() { throw new Error('Unexpected deletion') },
  }
  const service = new LibraryService(index, {
    async write(_id, index, source, signal, progress, checkpoint) {
      const entry = entries.get(index) ?? disk(source.source.size)
      entries.set(index, entry)
      if (index === 0) assert.equal(checkpoint, undefined)
      return copyLibraryFile(source, entry.open(), signal, progress, checkpoint)
    },
    async sources(_id, records) {
      return records.map((record, i) => ({ path: record.path, remoteIdentity: record.remoteIdentity,
        source: new BlobSource(new Blob([Uint8Array.from(entries.get(i)!.durable)])) }))
    },
    async recover() {}, async remove() { throw new Error('Durable copy was discarded') },
  }, { request: async (_name: string, _options: unknown, task: () => Promise<unknown>) => task() } as unknown as LockManager,
  { async estimate() { return {} }, async persisted() { return false } })
  const signal = new AbortController().signal
  try {
    const blob = new Blob([local]), identity = await gameIdentity([
      { path: 'local.bin', source: new BlobSource(blob) },
      { path: 'voice.bin', source: new BlobSource(new Blob([Uint8Array.from(remote)])), remoteIdentity },
    ])
    const options = { operation: 'first', title: 'Voices', entry: 'startup.tjs', backend: 'auto' as const, expectedGameId: identity }
    const files = (localBlob: Blob) => [{ path: 'local.bin', blob: localBlob }, { path: 'voice.bin', url }]
    await assert.rejects(service.importGame({ ...options, files: files(blob) }, signal, () => {}), /503/)
    const [draft] = (await index.catalog()).downloads
    assert(draft); assert.equal(draft.reopenable, false); assert.equal(hashes.size, 1)
    await assert.rejects(service.importGame({ download: draft.id, operation: 'missing-local' }, signal, () => {}), /本地文件/)
    local[90000] = 17 // Outside both 64 KiB game-identity samples.
    const mark = server.requests.length
    interrupt = false
    let reused = 0
    const game = await service.importGame({ ...options, operation: 'retry', files: files(new Blob([local])) }, signal,
      (progress) => { reused = progress.reused ?? 0 })
    assert.equal(game.id, draft.id); assert.equal(game.gameId, identity)
    assert.deepEqual(entries.get(0)!.durable, local); assert.equal(reused, block)
    assert.deepEqual(server.requests.slice(mark).filter((r) => r.method === 'GET').map((r) => r.range),
      ['bytes=0-0', 'bytes=1048576-1048598'])
  } finally { await server.close() }
})
