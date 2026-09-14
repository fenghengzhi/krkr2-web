import test from 'node:test'
import assert from 'node:assert/strict'
import {
  copyLibraryFile,
  hashBlock,
  OpfsReadPool,
  type LibraryWriter,
} from '../../src/backends/files/opfs-library.ts'
import {
  gameSettings,
  libraryId,
  validateRecord,
  LIBRARY_BLOCK_BYTES as B,
  type LibraryRecord,
} from '../../src/player/library/records.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { deferred } from '../helpers/http-server.ts'
const id = 'entry-00000000-0000-4000-8000-000000000000'
function writer() {
  let bytes = new Uint8Array(),
    closed = false,
    flushed = false
  const api: LibraryWriter = {
    write(value, { at }) {
      const n = Math.min(value.length, 71)
      if (bytes.length < at + n) {
        const next = new Uint8Array(at + n)
        next.set(bytes)
        bytes = next
      }
      bytes.set(value.subarray(0, n), at)
      return n
    },
    truncate(size) {
      bytes = new Uint8Array(size)
    },
    getSize() {
      return bytes.length
    },
    flush() {
      flushed = true
    },
    close() {
      closed = true
    },
  }
  return { api, snapshot: () => ({ bytes, closed, flushed }) }
}
function record(): LibraryRecord {
  return {
    version: 1,
    id,
    gameId: 'game-' + '0'.repeat(64),
    title: 'Sample',
    entry: 'startup.tjs',
    backend: 'auto',
    createdAt: 1,
    size: 0,
    fileCount: 1,
    files: [{ path: 'empty.bin', size: 0, hashes: [] }],
  }
}
test('library manifests reject unsafe identities, paths, digests, budgets and settings', () => {
  assert.equal(validateRecord(record()).id, id)
  for (const bad of [
    '../x',
    'entry-../../x',
    'other',
    'entry-00000000-0000-0000-0000-000000000000',
  ])
    assert.throws(() => libraryId(bad))
  for (const mutation of [
    (r: LibraryRecord) => {
      r.version = 2 as 1
    },
    (r: LibraryRecord) => {
      r.gameId = 'x'
    },
    (r: LibraryRecord) => {
      r.size = 1
    },
    (r: LibraryRecord) => {
      r.files[0].path = '../x'
    },
    (r: LibraryRecord) => {
      r.files[0].path = 'a>b'
    },
    (r: LibraryRecord) => {
      r.fileCount = 2
    },
    (r: LibraryRecord) => {
      r.files[0].hashes = ['x']
    },
    (r: LibraryRecord) => {
      r.createdAt = NaN
    },
    (r: LibraryRecord) => {
      r.size = r.files[0].size = B
      r.files[0].hashes = ['bad']
    },
    (r: LibraryRecord) => {
      r.size = r.files[0].size = Infinity
    },
  ]) {
    const r = record()
    mutation(r)
    assert.throws(() => validateRecord(r))
  }
  assert.deepEqual(
    gameSettings({ title: '  Game  ', entry: './scenario/start.tjs', backend: 'jspi' }),
    { title: 'Game', entry: 'scenario/start.tjs', backend: 'jspi' },
  )
  for (const entry of ['../start', '/start', 'x>start', ''])
    assert.throws(() => gameSettings({ title: 'Game', entry, backend: 'auto' }))
})
test('OPFS copy handles short writes, Unicode names and empty files, and hashes actual copied bytes', async () => {
  const bytes = Uint8Array.from({ length: 2003 }, (_, i) => i % 251),
    file = writer(),
    source = new BlobSource(new Blob([bytes]))
  let written = 0
  const result = await copyLibraryFile(
    { path: '音/empty.bin', source },
    file.api,
    new AbortController().signal,
    (n) => {
      written += n
    },
  )
  assert.equal(written, bytes.length)
  assert.deepEqual(result.hashes, [await hashBlock(bytes)])
  assert.deepEqual(file.snapshot().bytes, bytes)
  assert.equal(file.snapshot().closed, true)
  assert.equal(file.snapshot().flushed, true)
  const empty = writer()
  assert.deepEqual(
    (
      await copyLibraryFile(
        { path: 'empty', source: new BlobSource(new Blob()) },
        empty.api,
        new AbortController().signal,
        () => {},
      )
    ).hashes,
    [],
  )
  assert.ok(empty.snapshot().closed && empty.snapshot().flushed)
})
test('OPFS copy closes writers after cancellation, quota failure, incomplete writes or flush failure', async () => {
  for (const kind of ['cancel', 'quota', 'zero', 'flush', 'size']) {
    const f = writer(),
      abort = new AbortController(),
      bytes = new Uint8Array(200)
    if (kind === 'cancel') abort.abort(new DOMException('cancelled', 'AbortError'))
    if (kind === 'quota')
      f.api.write = () => {
        throw new DOMException('full', 'QuotaExceededError')
      }
    if (kind === 'zero') f.api.write = () => 0
    if (kind === 'flush')
      f.api.flush = () => {
        throw new Error('flush failed')
      }
    if (kind === 'size') f.api.getSize = () => 0
    await assert.rejects(
      copyLibraryFile(
        { path: 'a', source: new BlobSource(new Blob([bytes])) },
        f.api,
        abort.signal,
        () => {},
      ),
    )
    assert.equal(f.snapshot().closed, true)
  }
  const f = writer(),
    abort = new AbortController()
  let calls = 0
  await assert.rejects(
    copyLibraryFile(
      {
        path: 'a',
        source: {
          size: B * 2,
          read: async (_at, n) => {
            calls++
            return new Uint8Array(n)
          },
        },
      },
      f.api,
      abort.signal,
      () => abort.abort(),
    ),
    { name: 'AbortError' },
  )
  assert.equal(calls, 1)
  assert.equal(f.snapshot().closed, true)
})
test('verified OPFS blocks are lazy, shared, immutable and evicted across files', async () => {
  const abort = new AbortController(),
    pool = new OpfsReadPool(abort.signal, B)
  const bytes = new Uint8Array(B + 11).fill(7),
    hashes = [await hashBlock(bytes.subarray(0, B)), await hashBlock(bytes.subarray(B))]
  let reads = 0
  class CountingBlob extends Blob {
    override slice(start?: number, end?: number) {
      reads++
      return super.slice(start, end)
    }
  }
  const source = pool.source('a', new CountingBlob([bytes]), {
    path: 'a',
    size: bytes.length,
    hashes,
  })
  assert.equal(reads, 0)
  const [a, b] = await Promise.all([source.read(B - 3, 8), source.read(1, 1)])
  assert.deepEqual([...a], Array(8).fill(7))
  a.fill(0)
  b.fill(0)
  assert.equal(reads, 2)
  assert.equal(pool.inspect().cacheBytes, 11)
  assert.equal((await source.read(0, 1))[0], 7)
  assert.equal(reads, 3)
  const other = pool.source('b', new CountingBlob([bytes]), {
    path: 'b',
    size: bytes.length,
    hashes,
  })
  await other.read(0, 1)
  assert.equal(pool.inspect().cacheBytes, B)
  assert.equal(pool.inspect().pendingReadBytes, 0)
  abort.abort()
  assert.equal(pool.inspect().cacheBytes, 0)
  await assert.rejects(source.read(0, 1), { name: 'AbortError' })
})
test('OPFS corruption invalidates earlier cached blocks and truncated files fail before mounting', async () => {
  const pool = new OpfsReadPool(new AbortController().signal),
    bytes = new Uint8Array(B + 1)
  const source = pool.source('a', new Blob([bytes]), {
    path: 'a',
    size: bytes.length,
    hashes: [await hashBlock(bytes.subarray(0, B)), '0'.repeat(64)],
  })
  await source.read(0, 1)
  await assert.rejects(source.read(B, 1), /checksum/)
  await assert.rejects(source.read(0, 1), /checksum/)
  assert.equal(pool.inspect().cacheBytes, 0)
  const other = new OpfsReadPool(new AbortController().signal)
  assert.throws(
    () => other.source('x', new Blob(), { path: 'x', size: 1, hashes: ['0'.repeat(64)] }),
    /incomplete/,
  )
  pool.close()
  other.close()
})
test('stopping OPFS reads prevents late cache publication and output reservations are released', async () => {
  const gate = deferred<ArrayBuffer>(),
    abort = new AbortController(),
    pool = new OpfsReadPool(abort.signal)
  class SlowBlob extends Blob {
    override slice() {
      const b = new Blob()
      b.arrayBuffer = () => gate.promise
      return b
    }
  }
  const source = pool.source('a', new SlowBlob([new Uint8Array(1)]), {
    path: 'a',
    size: 1,
    hashes: [await hashBlock(new Uint8Array(1))],
  })
  const reading = source.read(0, 1),
    done = assert.rejects(reading, { name: 'AbortError' })
  abort.abort()
  await done
  gate.resolve(new ArrayBuffer(1))
  assert.deepEqual(pool.inspect(), { cacheBytes: 0, pendingBlocks: 0, pendingReadBytes: 0 })
})

test('OPFS copies files larger than the resource decode budget with bounded source reads', async () => {
  const size = 64 * B + 3
  let position = 0,
    largestRead = 0,
    calls = 0,
    closed = false
  const writer: LibraryWriter = {
    write(bytes, { at }) {
      assert.equal(at, position)
      position += bytes.length
      return bytes.length
    },
    truncate(n) {
      position = n
    },
    getSize() {
      return position
    },
    flush() {},
    close() {
      closed = true
    },
  }
  const result = await copyLibraryFile(
    {
      path: 'large.xp3',
      source: {
        size,
        read: async (_offset, length) => {
          calls++
          largestRead = Math.max(largestRead, length)
          return new Uint8Array(length)
        },
      },
    },
    writer,
    new AbortController().signal,
    () => {},
  )
  assert.equal(result.size, size)
  assert.equal(result.hashes.length, 65)
  assert.equal(largestRead, B)
  assert.equal(calls, 65)
  assert.ok(closed)
})

test('OPFS verified sources retain offsets above 4 GiB and validate all read bounds before allocating', async () => {
  const total = 2 ** 32 + 17,
    value = 2 ** 32 % 251
  class SparseBlob extends Blob {
    override get size() {
      return total
    }
    override slice(start = 0, end = total) {
      return new Blob([new Uint8Array(end - start).fill(start % 251)])
    }
  }
  const hashes = Array(Math.ceil(total / B)).fill('0'.repeat(64))
  hashes[hashes.length - 1] = await hashBlock(new Uint8Array(17).fill(value))
  const pool = new OpfsReadPool(new AbortController().signal),
    source = pool.source('large', new SparseBlob(), { path: 'large', size: total, hashes })
  assert.deepEqual([...(await source.read(total - 4, 4))], [value, value, value, value])
  for (const [offset, length] of [
    [-1, 1],
    [0, 64 * B + 1],
    [total, 1],
    [1.5, 0],
    [NaN, 0],
    [0, Infinity],
  ])
    await assert.rejects(source.read(offset, length), /bounds|budget/)
  assert.equal((await source.read(total, 0)).length, 0)
  pool.close()
})
