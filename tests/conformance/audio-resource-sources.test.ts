import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { AudioResourceSources } from '../../src/engine/storage/audio-sources.ts'
import { MAX_RESOURCE_BYTES, type Resource } from '../../src/engine/ports/storage.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function resource(size: number, read: () => Promise<Uint8Array>): Resource {
  return { name: 'sound.wav', size, read }
}
async function enteredBefore(entered: Promise<void>, operation: Promise<unknown>): Promise<void> {
  await Promise.race([entered, operation.then(() => { throw new Error('Operation completed before reaching its gate') })])
}

test('audio fallback reserves pending opens before reading and releases failed reservations', { timeout: 5000 }, async () => {
  const pool = new AudioResourceSources(() => {}), waiting = deferred<Uint8Array>(), entered = deferred<void>()
  const opening = pool.open(resource(40 * 1024 * 1024, () => { entered.resolve(); return waiting.promise }), () => true)
  const failure = assert.rejects(opening, /provider failed/)
  try {
    await enteredBefore(entered.promise, opening)
    let secondReads = 0
    await assert.rejects(pool.open(resource(32 * 1024 * 1024, async () => {
      secondReads++; return new Uint8Array()
    }), () => true), /64 MiB Session budget/)
    assert.equal(secondReads, 0)
    assert.deepEqual(pool.inspect(), { bufferedBytes: 40 * 1024 * 1024, leases: 1 })
  } finally { waiting.reject(new Error('provider failed')); await failure }
  assert.deepEqual(pool.inspect(), { bufferedBytes: 0, leases: 0 })
})

test('audio fallback owns one immutable compact copy and idempotently releases its budget', async () => {
  const pool = new AudioResourceSources(() => {}), original = new Uint8Array([1, 2, 3, 4])
  let reads = 0
  const lease = await pool.open(resource(4, async () => { reads++; return original }), () => true)
  original.fill(9)
  const first = await lease.source.read(1, 2)
  assert.deepEqual([...first], [2, 3])
  first.fill(8)
  assert.deepEqual([...await lease.source.read(1, 2)], [2, 3])
  assert.equal(reads, 1)
  assert.equal(lease.bufferedBytes, 4)
  lease.release(); lease.release()
  assert.deepEqual(pool.inspect(), { bufferedBytes: 0, leases: 0 })
  await assert.rejects(lease.source.read(0, 1), /closed/)
})

test('cancelled fallback read keeps its reservation until the original read has settled', { timeout: 5000 }, async () => {
  const entered = deferred<void>(), resume = deferred<void>()
  let blocked = false
  const pool = new AudioResourceSources(async () => {
    if (blocked) { entered.resolve(); await resume.promise }
  })
  const lease = await pool.open(resource(8, async () => new Uint8Array(8)), () => true)
  blocked = true
  const reading = lease.source.read(0, 4), failure = assert.rejects(reading, /closed/)
  try {
    await enteredBefore(entered.promise, reading)
    lease.release()
    assert.deepEqual(pool.inspect(), { bufferedBytes: 8, leases: 1 })
    blocked = false
    await assert.rejects(pool.open(resource(MAX_RESOURCE_BYTES, async () => {
      throw new Error('must reject before reading')
    }), () => true), /64 MiB Session budget/)
  } finally { lease.release(); blocked = false; resume.resolve(); await failure }
  assert.deepEqual(pool.inspect(), { bufferedBytes: 0, leases: 0 })
})

test('disposing an in-flight open invalidates its result but waits for borrowed work to release accounting', { timeout: 5000 }, async () => {
  const pool = new AudioResourceSources(() => {}), waiting = deferred<Uint8Array>(), entered = deferred<void>()
  const opening = pool.open(resource(8, () => { entered.resolve(); return waiting.promise }), () => true)
  const failure = assert.rejects(opening, /expired/)
  try {
    await enteredBefore(entered.promise, opening)
    pool.dispose()
    assert.deepEqual(pool.inspect(), { bufferedBytes: 8, leases: 1 })
    await failure
    assert.deepEqual(pool.inspect(), { bufferedBytes: 8, leases: 1 }, 'Cancelling the wait must not retire the real read budget')
  } finally { pool.dispose(); waiting.resolve(new Uint8Array(8)); await failure; await nextTurn() }
  assert.deepEqual(pool.inspect(), { bufferedBytes: 0, leases: 0 })
  await assert.rejects(pool.open(resource(0, async () => new Uint8Array()), () => true), /expired/)
})

test('range-backed audio borrows large resources without full reads and rejects late owner results', { timeout: 5000 }, async () => {
  const pool = new AudioResourceSources(() => {}), waiting = deferred<Uint8Array>(), entered = deferred<void>()
  let valid = true, fullReads = 0
  const file: Resource = {
    ...resource(MAX_RESOURCE_BYTES * 4, async () => { fullReads++; throw new Error('whole read') }),
    source: { size: MAX_RESOURCE_BYTES * 4, read: (offset, length) => {
    assert.equal(offset, MAX_RESOURCE_BYTES + 19); assert.equal(length, 3)
    entered.resolve(); return waiting.promise
    } },
  }
  const lease = await pool.open(file, () => valid)
  assert.equal(lease.bufferedBytes, 0)
  const reading = lease.source.read(MAX_RESOURCE_BYTES + 19, 3), failure = assert.rejects(reading, /expired/)
  try {
    await enteredBefore(entered.promise, reading)
    valid = false
    lease.release()
  } finally { valid = false; lease.release(); waiting.resolve(new Uint8Array(3)); await failure }
  assert.equal(fullReads, 0)
  assert.deepEqual(pool.inspect(), { bufferedBytes: 0, leases: 0 })
})
