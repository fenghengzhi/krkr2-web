import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { headless } from '../helpers/headless.ts'
import { LifetimeVideoBackend } from '../helpers/video-lifetime-backend.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { PortVideoBackend } from '../../src/backends/video/port-backend.ts'
import type { VideoRequest } from '../../src/protocol/video.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
const source = `
var sourceWindow=new Window(), sourceMovie=new VideoOverlay(sourceWindow);
function openSourceMovie(name){sourceMovie.open(name);sourceMovie.pause();return sourceMovie.status;}
`

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: VideoOverlay resolves real stored movie Blobs and Stop cancels pending materialization before any host open`, { timeout: 60000 }, async () => {
  const bytes = new Uint8Array(readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url))),
    archive = new Blob([Uint8Array.from(xp3Fixture({ 'movies/colors.mp4': bytes }).bytes).buffer]),
    channel = new MessageChannel(), host = new LifetimeVideoBackend(), requests: VideoRequest[] = [],
    hostErrors: unknown[] = [], video = new PortVideoBackend(channel.port1),
    entered = deferred<void>(), gate = deferred<Uint8Array>(), late = new Error('Late movie range failure'),
    failures: unknown[] = [], pending: Promise<unknown>[] = []
  channel.port2.onmessage = ({ data }: MessageEvent<VideoRequest>) => {
    requests.push(data)
    void host.command(data.command).then((result) => {
      channel.port2.postMessage({ type: 'reply', serial: data.serial, result })
    }, (error: unknown) => {
      hostErrors.push(error)
      channel.port2.postMessage({ type: 'reply', serial: data.serial, error: String(error) })
    })
  }
  const { session } = await headless({ 'movie-source.tjs': source, 'byte-movie.mp4': bytes,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("movie-source.tjs","savedata/movie-source.cjs",false,true,false);Scripts.execStorage("savedata/movie-source.cjs");'
      : 'Scripts.execStorage("movie-source.tjs");',
  }, { video })
  session.mount([{ name: 'data.xp3', size: archive.size, source: new BlobSource(archive), read: async () => {
    throw new Error('Movie archive must use its range capability')
  } }, { name: 'held-movie.mp4', size: 2 * 1024 ** 2, read: async () => { throw new Error('Whole movie read forbidden') },
    source: { size: 2 * 1024 ** 2, read: async (_offset, length) => {
      if (length === 1024 * 1024) { entered.resolve(); return gate.promise }
      // Any unrelated archive signature probe remains independent of the
      // deliberate movie payload wait, as it is with a real file source.
      return new Uint8Array(length)
    } },
  }])
  try {
    await session.start()
    if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
      .find((entry) => entry.path === 'savedata/movie-source.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    assert.equal(await session.evaluate('openSourceMovie("data.xp3>movies/colors.mp4?tag=public")'), 'pause')
    assert.equal(await session.evaluate('openSourceMovie("byte-movie.mp4")'), 'pause')
    const opens = requests.map((request) => request.command).filter((command) => command.op === 'open')
    assert.equal(opens.length, 2)
    for (const [index, command] of opens.entries()) {
      assert(!(command.bytes instanceof Uint8Array)); assert(command.bytes.blob instanceof Blob)
      assert.equal(command.bytes.buffered, index === 1)
      assert.deepEqual(new Uint8Array(await command.bytes.blob.arrayBuffer()), bytes)
      assert(command.timeline && command.timeline.times.length > 1)
    }
    assert.equal(opens[0]!.name, 'data.xp3>movies/colors.mp4?tag=public')
    assert.deepEqual(video.inspectSources(), { preparations: 0, bufferedBytes: 0, metadataBytes: 0 })
    const opening = session.evaluate('openSourceMovie("held-movie.mp4")')
    pending.push(opening); void opening.catch(() => {})
    await Promise.race([entered.promise, opening.then(() => { throw new Error('The movie never reached its real source read') })])
    assert.equal(host.movies.size, 0, 'Native open has already retired the previous graph')
    assert.equal(video.inspectSources().bufferedBytes, 2 * 1024 ** 2)
    const rejected = assert.rejects(opening, /cancel|closed|expired/i)
    await session.stop(); await rejected
    assert.equal(requests.filter((request) => request.command.op === 'open').length, 2)
    assert.equal(video.inspectSources().preparations, 1, 'Actual late I/O remains accounted after the VM is free')
    gate.reject(late)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(video.inspectSources(), { preparations: 0, bufferedBytes: 0, metadataBytes: 0 })
    assert.equal(host.movies.size, 0); assert.equal(host.listeners.size, 0)
    assert.deepEqual(hostErrors, [])
  } catch (error) { failures.push(error) }
  gate.reject(late)
  await Promise.allSettled(pending)
  try {
    await session.stop(); await video.close()
    assert.equal(session.snapshot().handles, 0)
    assert(Object.values(session.inspectOwnership()).every((count) => count === 0))
  } catch (error) { failures.push(error) }
  channel.port2.close()
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Movie source route or cleanup failed', { cause: failures[0] })
})
