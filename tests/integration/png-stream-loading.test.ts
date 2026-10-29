import test from 'node:test'
import assert from 'node:assert/strict'
import type { ImageInflater, ImageInflaterProvider } from '../../src/engine/ports/image-inflater.ts'
import { headless } from '../helpers/headless.ts'
import { createHeadlessImageInflaterProvider } from '../helpers/image-zlib.ts'
import { pngStreamConsumerFiles, pngStreamConsumerSource, streamMainKey } from '../helpers/png-stream-consumer-fixtures.ts'

async function fixture(binary: boolean) {
  const actual = createHeadlessImageInflaterProvider(), live = new Set<ImageInflater>(), reads = new Map<string, number>(),
    frames: unknown[][] = []
  let opened = 0, closed = 0
  const imageInflater: ImageInflaterProvider = {
    async open(source, length) {
      const stream = await actual.open(source, length)
      let done = false
      const owned: ImageInflater = {
        step(input, output) { return stream.step(input, output) },
        close() { if (!done) { done = true; closed++; live.delete(owned); stream.close() } },
      }
      live.add(owned); opened++
      return owned
    },
    dispose() {
      const errors: unknown[] = []
      for (const stream of [...live]) try { stream.close() } catch (error) { errors.push(error) }
      try { actual.dispose() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'Stream fixture inflater cleanup failed')
    },
  }
  const f = await headless({}, { imageInflater,
    renderer: { present(layers) { frames.push(layers.map(({ id, pixels }) => ({ id,
      width: pixels.width, height: pixels.height, data: [...pixels.data] }))) }, dispose() {} },
  }), files: Record<string, string | Uint8Array> = { ...pngStreamConsumerFiles(), 'stream.tjs': pngStreamConsumerSource,
    'startup.tjs': binary ? 'Scripts.compileStorage("stream.tjs","savedata/stream.cjs",false,true,false);Scripts.execStorage("savedata/stream.cjs");'
      : 'Scripts.execStorage("stream.tjs");' }
  f.session.mount(Object.entries(files).map(([name, value]) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    return { name, size: bytes.length, cacheToken: {}, async read() { reads.set(name, (reads.get(name) ?? 0) + 1); return bytes } }
  }))
  try {
    await f.session.start()
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
      .find((file) => file.path === 'savedata/stream.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    const id = Number(await f.session.evaluate('streamLayer.__id'))
    return { ...f, reads, frames, id, opened: () => opened, closed: () => closed, active: () => live.size,
      load: (name: string, key: number) => f.session.evaluate(`streamLoad(${JSON.stringify(name)},${key})`),
      reset: () => f.session.evaluate('(resetStream(),0)'),
    }
  } catch (error) {
    try { await f.session.stop() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Stream fixture setup and cleanup failed', { cause: error }) }
    throw error
  }
}
async function using(binary: boolean, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(binary), failures: unknown[] = []
  try { await run(f) } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.active(), 0)
    assert.equal(f.opened(), f.closed())
    assert.equal(f.session.snapshot().imageCacheResidentBytes, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Stream image assertion and cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: real pull PNG preserves raw main bytes before final-row keying, but does not bind an incomplete mask row`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      for (const [name, key, expected] of [
        ['raw-main.png', streamMainKey, [0x112233, 0, 0xc86432, 255, 0x112233, 99, 0xc86432, 110]],
        ['raw-mask.bmp', 0x04ffffff, [0x112233, 32, 0xc86432, 48, 0x112233, 200, 0xc86432, 200]],
      ] as const) for (let attempt = 1; attempt <= 2; attempt++) {
        await f.reset()
        const before = f.frames.length
        assert.equal(await f.load(name, key), 'stream-png:IDAT: CRC error')
        assert.equal(await f.session.evaluate('streamPixels()'), expected.join(','))
        assert.equal(await f.session.evaluate('streamState()'), '3,3,2,2,-1,-1,1,1,1,1,0,91')
        assert.equal(f.frames.length, before, 'A failed main/mask operation does not request final Update')
        assert.equal(f.session.snapshot().imageCacheEntries, 0)
        assert.equal(f.reads.get(name), attempt, 'A failed processed image is read again')
        assert.equal(f.active(), 0, 'The failing PNG decoder closes its real zlib stream')
        assert.equal(f.opened(), f.closed())
      }
      assert.equal(f.reads.get('raw-mask_m.png'), 2)
      assert.equal(f.opened(), 4)
    })
  })

  test(`${mode}: a valid split trailer completes keying before cache insertion and replay owns its pixels`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      const expected = [0x112233, 0, 0xc86432, 255, 0x112233, 0, 0xc86432, 255].join(',')
      assert.equal(await f.load('good.png', streamMainKey), 'ok')
      assert.equal(await f.session.evaluate('streamPixels()'), expected)
      assert.equal(await f.session.evaluate('streamState()'), '2,2,2,2,0,0,0,0,2,2,1,0')
      assert.equal(f.active(), 0); assert.equal(f.opened(), 1); assert.equal(f.closed(), 1)
      assert.equal(f.session.snapshot().imageCacheEntries, 1)
      await f.session.evaluate('(streamLayer.setMainPixel(1,1,0xabcdef),0)')
      assert.equal(await f.load('good.png', streamMainKey), 'ok')
      assert.equal(await f.session.evaluate('streamPixels()'), expected)
      assert.equal(f.reads.get('good.png'), 1)
      assert.equal(f.opened(), 1, 'A finished cache hit never opens a new inflater')
      assert.deepEqual(f.frames.at(-1)!.find((frame) => (frame as { id: number }).id === f.id), { id: f.id,
        width: 2, height: 2, data: [17,34,51,0,200,100,50,255,17,34,51,0,200,100,50,255] })
    })
  })
}
