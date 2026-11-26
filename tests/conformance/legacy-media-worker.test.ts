import assert from 'node:assert/strict'
import test from 'node:test'
import { configureLegacyMedia, transcodeLegacyMovie, type LegacyMediaReply, type LegacyMediaRequest } from '../../src/backends/video/legacy/transcode.ts'

// Transport ownership only. The separate legacy-media test invokes the actual
// pinned WASM; this deliberately does not pretend a fake Worker decodes media.
test('legacy conversion retires its Worker on cancellation and ignores late replies without poisoning the next movie', async () => {
  const original = globalThis.Worker, instances: OwnedWorker[] = [],
    reason = new Error('This movie was replaced'), cancel = new AbortController(), next = new AbortController()
  class OwnedWorker {
    onmessage: ((event: MessageEvent<LegacyMediaReply>) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    onmessageerror: (() => void) | null = null
    request?: LegacyMediaRequest
    terminated = 0
    constructor(readonly url: URL, readonly options: WorkerOptions) { instances.push(this) }
    postMessage(request: LegacyMediaRequest) { this.request = request }
    terminate() { this.terminated++ }
  }
  globalThis.Worker = OwnedWorker as unknown as typeof Worker
  try {
    configureLegacyMedia('https://example.invalid/player/legacy-media/manifest-a.json')
    const first = transcodeLegacyMovie(Uint8Array.of(1, 2, 3), 'mpeg', cancel.signal).catch((error: unknown) => error),
      worker = instances[0]!, late = worker.onmessage,
      reply: LegacyMediaReply = { type: 'done', format: 'mpeg', inputBytes: 3, outputBytes: 8,
        blob: new Blob([new Uint8Array(8)], { type: 'video/mp4' }), log: [] }
    assert.equal(worker.options.name, 'krkr-legacy-movie')
    assert.equal(worker.options.type, 'module')
    assert.equal(worker.request!.manifestUrl, 'https://example.invalid/player/legacy-media/manifest-a.json')
    assert.deepEqual(new Uint8Array(await worker.request!.input.arrayBuffer()), Uint8Array.of(1, 2, 3))
    configureLegacyMedia('https://example.invalid/other/legacy-media/manifest-b.json')
    assert.equal(worker.request!.manifestUrl, 'https://example.invalid/player/legacy-media/manifest-a.json')
    cancel.abort(reason)
    assert.equal(await first, reason)
    assert.equal(worker.terminated, 1); assert.equal(worker.onmessage, null)
    late?.({ data: reply } as MessageEvent<LegacyMediaReply>)
    assert.equal(worker.terminated, 1)

    const recovered = transcodeLegacyMovie(new Blob([Uint8Array.of(4, 5, 6)]), 'avi', next.signal), second = instances[1]!
    assert.equal(second.request!.manifestUrl, 'https://example.invalid/other/legacy-media/manifest-b.json')
    second.onmessage!({ data: { ...reply, format: 'avi' } } as MessageEvent<LegacyMediaReply>)
    assert.equal(await recovered, reply.blob)
    assert.equal(second.terminated, 1); assert.equal(second.onmessage, null)
    const before = instances.length
    await assert.rejects(transcodeLegacyMovie(Uint8Array.of(7), 'avi', cancel.signal), (error) => error === reason)
    assert.equal(instances.length, before, 'Already-cancelled work must never acquire a Worker')
  } finally { cancel.abort(reason); next.abort(reason); globalThis.Worker = original }
})
