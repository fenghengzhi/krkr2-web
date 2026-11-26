import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlobSource, inflate } from '../../src/backends/files/blob-source.ts'
import { importSources } from '../../src/backends/files/import-resources.ts'
import { prepareVideoBlob } from '../../src/backends/files/video-source.ts'
import { PortVideoBackend } from '../../src/backends/video/port-backend.ts'
import { PausableTimeouts } from '../../src/backends/shared/pausable-timeouts.ts'
import { ExecutionCancelled } from '../../src/engine/scheduler/control.ts'
import { openResourceSource } from '../../src/engine/storage/resource-source.ts'
import { MAX_RESOURCE_BYTES, type Resource } from '../../src/engine/ports/storage.ts'
import { defaultVideoSettings, videoSourceLimits, type VideoCommand, type VideoSourceControl } from '../../src/engine/ports/video.ts'
import type { VideoRequest } from '../../src/protocol/video.ts'
import { readVideoTimeline, readVideoTimelineBlob } from '../../src/formats/video/mp4.ts'
import { readXp3 } from '../../src/formats/xp3/archive.ts'
import { readZip } from '../../src/formats/zip/archive.ts'
import { xp3Fixture, embedXp3 } from '../helpers/xp3-fixtures.ts'
import { writeSegmentedMovieXp3 } from '../helpers/large-video-game.ts'
import { archiveReader } from '../../src/backends/files/archive-reader.ts'
import { zipFixture, zipCodecs, centralRecords } from '../helpers/zip-fixtures.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

test('a movie split around another XP3 member borrows slices in logical playback order', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'krkr-split-movie-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const content = Uint8Array.of(2, 3, 5, 7, 11, 13, 17, 19), movie = join(dir, 'scene.avi'),
    archive = join(dir, 'data.xp3'), split = 5, script = 'System.title="Chapter";'
  await writeFile(movie, content)
  await writeSegmentedMovieXp3(archive, movie, 'scene.avi', content.length, split, script)
  const source = new BlobSource(new Blob([Uint8Array.from(await readFile(archive))])),
    borrowed: number[][] = [], ranges: number[][] = [],
    [entry, film] = await readXp3({ size: source.size,
      read: async (at, n) => { ranges.push([at, n]); return source.read(at, n) },
      borrowBlob: async (at, n) => { borrowed.push([at, n]); return source.borrowBlob(at, n) },
    }, inflate, { joinBlobs: archiveReader.joinBlobs })
  assert.equal(new TextDecoder().decode(await entry!.read()), script)
  const view = film!.source; assert(view?.borrowBlob)
  const reads = ranges.length, fromHead = 19 + (content.length - split) + Buffer.byteLength(script)
  const slice = await view.borrowBlob(3, 4)
  assert.deepEqual(borrowed, [[fromHead + 3, 2], [19, 2]])
  assert.deepEqual(new Uint8Array(await slice.arrayBuffer()), content.slice(3, 7))
  const media = await prepareVideoBlob(film!, controls().control)
  assert.equal(media.buffered, false)
  assert.deepEqual(new Uint8Array(await media.blob.arrayBuffer()), content)
  assert.equal(ranges.length, reads)
  assert.equal((await view.borrowBlob(view.size, 0)).size, 0)
  const cancellation = new Error('Scene closed')
  await assert.rejects(view.borrowBlob(0, 8, () => { throw cancellation }), (error) => error === cancellation)
})
function controls() {
  let cancelled = false
  const listeners = new Set<() => void>(), check = () => { if (cancelled) throw new ExecutionCancelled() }
  const control: VideoSourceControl = { check, checkpoint: async () => check(), onCancel(callback) {
    if (cancelled) callback(); else listeners.add(callback)
    return () => { listeners.delete(callback) }
  } }
  return { control, cancel() { cancelled = true; for (const callback of listeners) callback(); listeners.clear() } }
}
const neverRead = async (): Promise<Uint8Array> => { throw new Error('Whole resource read forbidden') }
const blobResource = (blob: Blob): Resource => ({ name: 'movie.mp4', size: blob.size, source: new BlobSource(blob), read: neverRead })
type OpenCommand = Extract<VideoCommand, { op: 'open' }>
const opening = (bytes: OpenCommand['bytes'], id = 1, epoch = 1): OpenCommand =>
  ({ op: 'open', id, epoch, name: 'movie.mp4', bytes, settings: defaultVideoSettings() })
function port(readBlob = readVideoTimelineBlob, timeouts?: PausableTimeouts) {
  const channel = new MessageChannel(), requests: VideoRequest[] = [], received = new Set<(request: VideoRequest) => void>()
  let holdOpen = false
  channel.port2.onmessage = ({ data }: MessageEvent<VideoRequest>) => {
    requests.push(data)
    for (const listener of received) listener(data)
    if (!(holdOpen && data.command.op === 'open'))
      channel.port2.postMessage({ type: 'reply', serial: data.serial, result: { events: [] } })
  }
  const backend = new PortVideoBackend(channel.port1, readVideoTimeline, readBlob, timeouts)
  return { backend, requests, channel, hold() { holdOpen = true },
    next(op: VideoCommand['op']) {
      return new Promise<VideoRequest>((resolve) => {
        const listener = (request: VideoRequest) => { if (request.command.op === op) { received.delete(listener); resolve(request) } }
        received.add(listener)
      })
    }, async close() { try { await backend.close() } finally { channel.port2.close() } } }
}

test('large immutable imported files and embedded stored XP3 retain Blob views without granting bulk reads', { timeout: 60000 }, async () => {
  const block = new Blob([new Uint8Array(1024 * 1024)]), large = new Blob([...Array<Blob>(65).fill(block), Uint8Array.of(17, 29)]),
    original = blobResource(large), [mounted] = await importSources([{ path: 'large.mp4', source: original.source! }], async () => {}, { lazyArchives: true })
  assert(mounted)
  const opened = await openResourceSource(mounted), prepared = await prepareVideoBlob({ ...mounted, source: opened.source }, controls().control)
  assert.equal(prepared.buffered, false); assert.equal(prepared.blob.size, 65 * 1024 ** 2 + 2)
  assert.deepEqual(new Uint8Array(await prepared.blob.slice(-2).arrayBuffer()), Uint8Array.of(17, 29))
  await assert.rejects(mounted.read(), /budget/)
  await assert.rejects(opened.source.read(0, MAX_RESOURCE_BYTES + 1), /64 MiB/)
  const payload = Uint8Array.of(2, 4, 6, 8), file = embedXp3(xp3Fixture({ 'movie.mp4': payload }).bytes),
    physical = new BlobSource(new Blob([Uint8Array.from(file).buffer])), reads: [number, number][] = [],
    source = { size: physical.size, borrowBlob: physical.borrowBlob.bind(physical), read: async (at: number, length: number) => {
      reads.push([at, length]); return physical.read(at, length)
    } }, [member] = await readXp3(source, inflate)
  assert(member?.source?.borrowBlob)
  reads.length = 0
  const movie = await prepareVideoBlob(member, controls().control)
  assert.equal(movie.buffered, false); assert.deepEqual(reads, [])
  assert.deepEqual(new Uint8Array(await movie.blob.arrayBuffer()), payload)
})

test('stored ZIP Blob borrowing preserves CRC and a cancelled scan does not poison a later reader', { timeout: 60000 }, async () => {
  const bytes = zipFixture('0-stream0-local640-zip640.zip'), source = new BlobSource(new Blob([Uint8Array.from(bytes).buffer])),
    [member] = await readZip(source, zipCodecs)
  assert(member?.source?.borrowBlob)
  const sentinel = new Error('This movie was closed')
  let checks = 0
  await assert.rejects(member.source.borrowBlob(0, member.size, () => { if (++checks === 2) throw sentinel }), (error) => error === sentinel)
  const payload = await prepareVideoBlob(member, controls().control)
  assert.equal(payload.buffered, false)
  assert.deepEqual(new Uint8Array(await payload.blob.arrayBuffer()), await member.read())
  // The reference starts with an empty folder/ record. Its data offset is
  // the next local header, so select the actual returned file by name before
  // damaging its payload. This remains a CRC failure, not a header failure.
  const corrupted = Buffer.from(bytes), selected = centralRecords(corrupted).records.find((record) => record.name === member.name)
  assert(selected); assert(member.size > 0)
  assert.equal(corrupted.readUInt16LE(selected.local + 8), 0)
  assert.equal(corrupted.readUInt32LE(selected.local + 18), member.size)
  corrupted[selected.data] = corrupted[selected.data]! ^ 1
  const bad = (await readZip(new BlobSource(new Blob([Uint8Array.from(corrupted).buffer])), zipCodecs))
    .find((resource) => resource.name === member.name)
  assert(bad)
  await assert.rejects(prepareVideoBlob(bad, controls().control), /CRC32 mismatch/)
  const [compressed] = await readXp3(new BlobSource(new Blob([Uint8Array.from(xp3Fixture({ 'movie.mp4': Uint8Array.of(1, 2, 3) }, { compressed: true }).bytes).buffer])), inflate)
  assert(compressed); assert.equal(compressed.source?.borrowBlob, undefined)
  assert.equal((await prepareVideoBlob(compressed, controls().control)).buffered, true)
})

test('range video materialization is bounded, copied, and distinct from immutable borrowing', { timeout: 60000 }, async () => {
  const size = 65 * 1024 ** 2 + 3, reads: [number, number][] = [], scratch = new Uint8Array(1024 * 1024),
    resource: Resource = { name: 'range.mp4', size, read: neverRead, source: { size, read: async (at, length) => {
      assert(length <= 1024 * 1024); reads.push([at, length]); scratch.fill((at / (1024 * 1024)) & 255)
      return scratch.subarray(0, length)
    } } }, payload = await prepareVideoBlob(resource, controls().control)
  scratch.fill(255)
  assert.equal(payload.buffered, true); assert.equal(payload.blob.size, size)
  assert.equal(reads.length, 66); assert.deepEqual(reads.at(-1), [65 * 1024 ** 2, 3])
  assert.deepEqual(new Uint8Array(await payload.blob.slice(1024 * 1024, 1024 * 1024 + 4).arrayBuffer()), Uint8Array.of(1, 1, 1, 1))
  assert.deepEqual(new Uint8Array(await payload.blob.slice(-3).arrayBuffer()), Uint8Array.of(65, 65, 65))
  await assert.rejects(prepareVideoBlob({ name: 'old-api.mp4', size, read: neverRead }, controls().control), /fallback budget/)
})

test('closing a held video read releases its waiter while preserving the actual pending allocation until settlement', { timeout: 60000 }, async () => {
  const f = port(), c = controls(), gate = deferred<Uint8Array>(), entered = deferred<void>(), failure = new Error('Late storage failure')
  const resource: Resource = { name: 'held.mp4', size: 8, read: neverRead, source: { size: 8, read: async () => { entered.resolve(); return gate.promise } } }
  try {
    const work = f.backend.prepareSource(resource, c.control), rejected = assert.rejects(work, ExecutionCancelled)
    await entered.promise; c.cancel(); await rejected
    assert.deepEqual(f.backend.inspectSources(), { preparations: 1, bufferedBytes: 8, metadataBytes: 0 })
    gate.reject(failure)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const next = await f.backend.prepareSource(blobResource(new Blob([Uint8Array.of(1)])), controls().control)
    next.release(); next.release()
    assert.deepEqual(f.backend.inspectSources(), { preparations: 0, bufferedBytes: 0, metadataBytes: 0 })
    await assert.rejects(f.backend.prepareSource({ ...resource, source: { size: 8, read: async () => { throw failure } } }, controls().control), (error) => error === failure)
  } finally { gate.reject(failure); await f.close() }
})

test('source leases enforce aggregate buffered bytes, maximum borrowed size and 64 active preparations', { timeout: 60000 }, async () => {
  const f = port(), c = controls(), gate = deferred<Uint8Array>(), entered = deferred<void>(), leases: Array<{ release(): void }> = []
  let reads = 0
  try {
    const size = videoSourceLimits.bufferedBytes, resource: Resource = { name: 'held', size, read: neverRead, source: { size,
      read: async () => { reads++; entered.resolve(); return gate.promise } } }, first = f.backend.prepareSource(resource, c.control),
      rejected = assert.rejects(first, ExecutionCancelled)
    await entered.promise
    await assert.rejects(f.backend.prepareSource({ ...resource, size: 1, source: { size: 1, read: async () => { reads++; return Uint8Array.of(1) } } }, controls().control), /preparation budget/)
    assert.equal(reads, 1)
    c.cancel(); await rejected; gate.resolve(new Uint8Array(1024 * 1024))
    await new Promise<void>((resolve) => setImmediate(resolve))
    // Let the cancelled source finish before filling the separate count budget.
    const next = await f.backend.prepareSource(blobResource(new Blob()), controls().control); next.release()
    for (let i = 0; i < 64; i++) leases.push(await f.backend.prepareSource(blobResource(new Blob()), controls().control))
    await assert.rejects(f.backend.prepareSource(blobResource(new Blob()), controls().control), /preparation budget/)
    for (const lease of leases) lease.release()
    const oversized = { ...blobResource(new Blob()), size: videoSourceLimits.borrowedBytes + 1 }
    await assert.rejects(f.backend.prepareSource(oversized, controls().control), /source budget/)
    assert.equal(f.backend.inspectSources().preparations, 0)
  } finally { c.cancel(); gate.resolve(new Uint8Array(1024 * 1024)); for (const lease of leases) lease.release(); await f.close() }
})

test('a real Blob crosses the video port with its exact metadata, bytes and buffered provenance', { timeout: 60000 }, async () => {
  const bytes = new Uint8Array(readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url))), f = port()
  try {
    for (const borrowed of [true, false]) {
      const resource = borrowed ? blobResource(new Blob([bytes])) : { name: 'movie.mp4', size: bytes.length, read: async () => bytes },
        prepared = await f.backend.prepareSource(resource, controls().control)
      try {
        await f.backend.command(opening(prepared.bytes))
        const command = f.requests.at(-1)!.command
        assert.equal(command.op, 'open'); if (command.op !== 'open') throw new Error('Missing open')
        assert(!(command.bytes instanceof Uint8Array)); assert(command.bytes.blob instanceof Blob)
        assert.equal(command.bytes.buffered, !borrowed)
        assert.deepEqual(new Uint8Array(await command.bytes.blob.arrayBuffer()), bytes)
        assert.deepEqual(command.timeline, await readVideoTimeline(bytes))
      } finally { prepared.release() }
    }
    assert.deepEqual(f.backend.inspectSources(), { preparations: 0, bufferedBytes: 0, metadataBytes: 0 })
  } finally { await f.close() }
})

test('parallel metadata reservations remain charged until a cancelled real source reader settles', { timeout: 60000 }, async () => {
  const gate = deferred<void>(), entered = deferred<void>(), c = controls(), f = port(async (_blob, options) => {
    options?.reserveMetadata?.(40 * 1024 ** 2); entered.resolve(); await gate.promise
    await options?.checkpoint?.(); return undefined
  })
  try {
    const source = await f.backend.prepareSource({ name: 'small', size: 1, read: async () => Uint8Array.of(1) }, c.control),
      first = f.backend.command(opening(source.bytes)), rejected = assert.rejects(first, ExecutionCancelled)
    await entered.promise
    await assert.rejects(f.backend.command(opening({ blob: new Blob(), buffered: false }, 2)), /metadata exceeds/)
    c.cancel(); await rejected; source.release()
    assert.deepEqual(f.backend.inspectSources(), { preparations: 1, bufferedBytes: 1, metadataBytes: 40 * 1024 ** 2 })
    gate.resolve()
    await f.backend.command({ op: 'close', id: 1, epoch: 2 })
    assert.deepEqual(f.backend.inspectSources(), { preparations: 0, bufferedBytes: 0, metadataBytes: 0 })
    assert.equal(f.requests.some((request) => request.command.op === 'open'), false)
  } finally { gate.resolve(); await f.close() }
})

test('timed-out Blob opens retire only their matching graph, with a bounded close and no late reply resurrection', { timeout: 60000 }, async () => {
  let now = 0
  const jobs = new Set<{ at: number; callback(): void }>(), timeouts = new PausableTimeouts({ now: () => now,
    schedule(callback, delay) { const job = { at: now + delay, callback }; jobs.add(job); return () => { jobs.delete(job) } } }),
    advance = () => { now += 20000; for (const job of [...jobs]) if (job.at <= now) { jobs.delete(job); job.callback() } },
    f = port(async () => undefined, timeouts)
  try {
    f.hold()
    const seen = f.next('open'), command = opening({ blob: new Blob(), buffered: false }),
      work = f.backend.command(command), rejected = assert.rejects(work, /open timed out/)
    const original = await seen, closed = f.next('close')
    command.epoch = 9 // A caller reusing its request object cannot retarget the pending cleanup.
    advance(); await rejected
    const retirement = await closed
    assert.deepEqual(retirement.command, { op: 'close', id: 1, epoch: 1 })
    f.channel.port2.postMessage({ type: 'reply', serial: original.serial, result: { events: [] } })
    const olderSeen = f.next('open'), older = f.backend.command(opening({ blob: new Blob(), buffered: false }, 2, 3)),
      olderRejected = assert.rejects(older, /open timed out/)
    await olderSeen
    const newerSeen = f.next('open'), newer = f.backend.command(opening({ blob: new Blob(), buffered: false }, 2, 4)),
      newerRejected = assert.rejects(newer, /open timed out/)
    await newerSeen
    const newerClose = f.next('close'); advance(); await Promise.all([olderRejected, newerRejected]); await newerClose
    assert.deepEqual(f.requests.filter((request) => request.command.op === 'close').map((request) => request.command),
      [{ op: 'close', id: 1, epoch: 1 }, { op: 'close', id: 2, epoch: 4 }])
  } finally { await f.close() }
  assert.equal(jobs.size, 0)
})
