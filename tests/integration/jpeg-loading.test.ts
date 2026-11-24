import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { createHeadlessImageJpegProvider } from '../helpers/image-jpeg.ts'
import { jpegContractFiles, jpegContractSource, jpegError, jpegErrorCodes, jpegRgba } from '../helpers/jpeg-contract.ts'
import type { ImageJpegDecoder, ImageJpegProvider } from '../../src/engine/ports/image-jpeg.ts'
import type { ExecutionControl } from '../../src/engine/scheduler/control.ts'

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), 10000)
  })]) } finally { clearTimeout(timer) }
}
function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then((value) => ({ status: 'fulfilled', value }), (reason: unknown) => ({ status: 'rejected', reason }))
}

async function fixture(binary: boolean, startupPrecision?: string) {
  const files: Record<string, string | Uint8Array> = { ...jpegContractFiles(), 'jpeg.tjs': jpegContractSource + `
function jpegSetPrecision(value){System.setArgument("-jpegdec",value);return System.getArgument("-jpegdec");}
`,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("jpeg.tjs","savedata/jpeg.cjs",false,true,false);Scripts.execStorage("savedata/jpeg.cjs");'
      : 'Scripts.execStorage("jpeg.tjs");' }
  let control!: ExecutionControl, opened = 0, closed = 0, steps = 0, sourceFailure: Error | undefined
  const actual = createHeadlessImageJpegProvider(() => control), active = new Set<ImageJpegDecoder>(),
    gates: { entered: ReturnType<typeof signal>; release: ReturnType<typeof signal>; delivered: ReturnType<typeof signal> }[] = [],
    requests: { mode: string; precision: string; warnings: number; warningCode?: number }[] = [], reads = new Map<string, number>()
  let nextGate: typeof gates[number] | undefined
  const imageJpeg: ImageJpegProvider = {
    async open(source, mode, precision) {
      const request: typeof requests[number] = { mode, precision, warnings: 0 }
      requests.push(request)
      if (sourceFailure) { const error = sourceFailure; sourceFailure = undefined; await Promise.resolve(); throw error }
      const decoder = await actual.open(source, mode, precision), gate = nextGate
      nextGate = undefined
      let live = true
      const owned: ImageJpegDecoder = {
        step(input, eof) {
          steps++
          const result = decoder.step(input, eof)
          request.warnings = result.warnings.count; request.warningCode = result.warnings.lastCode
          return result
        },
        close() { if (live) { live = false; decoder.close(); closed++; active.delete(owned) } },
      }
      opened++; active.add(owned)
      if (gate) { gate.entered.resolve(); await gate.release.promise; gate.delivered.resolve() }
      return owned
    },
    dispose() {
      const errors: unknown[] = []
      for (const decoder of [...active]) try { decoder.close() } catch (error) { errors.push(error) }
      try { actual.dispose() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'Observed JPEG provider cleanup failed')
    },
  }
  const frames: { id: number; data: number[] }[][] = [], f = await headless({}, { imageJpeg,
    arguments: new Map(startupPrecision === undefined ? [] : [['-jpegdec', startupPrecision]]),
    renderer: { present(layers) { frames.push(layers.map(({ id, pixels }) => ({ id, data: [...pixels.data] }))) }, dispose() {} },
  })
  control = f.session.control
  f.session.mount(Object.entries(files).map(([name, value]) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    return { name, size: bytes.length, cacheToken: {}, async read() { reads.set(name, (reads.get(name) ?? 0) + 1); return bytes } }
  }))
  try {
    await f.session.start()
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
      .find((file) => file.path === 'savedata/jpeg.cjs')!.bytes.subarray(0, 4)), 'TJS2')
  } catch (error) {
    try { await f.session.stop() } catch (cleanup) { throw new AggregateError([error, cleanup], 'JPEG fixture startup and cleanup failed', { cause: error }) }
    throw error
  }
  return { ...f, reads, frames, requests, active: () => active.size, opened: () => opened, closed: () => closed, steps: () => steps,
    failNext(error: Error) { sourceFailure = error },
    gateNext() { const gate = { entered: signal(), release: signal(), delivered: signal() }; gates.push(gate); nextGate = gate; return gate },
    releaseAll() { for (const gate of gates) gate.release.resolve() },
    load: (name: string, key = 'clNone', target = 'jpegImage') => f.session.evaluate(`jpegLoad(${target},${JSON.stringify(name)},${key})`),
  }
}
async function using(binary: boolean, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, startupPrecision?: string) {
  const f = await fixture(binary, startupPrecision), failures: unknown[] = []
  try { await run(f) } catch (error) { failures.push(error) }
  f.releaseAll()
  try {
    await f.session.stop()
    assert.equal(f.active(), 0); assert.equal(f.opened(), f.closed())
    assert.equal(f.session.snapshot().bitmapBytes, 0)
    assert.equal(f.session.snapshot().imageCacheBytes, 0)
    assert.equal(f.session.snapshot().imageCacheResidentBytes, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'JPEG consumer or cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: JPEG startup precision remains fixed across script argument changes before and after the first decode`, { timeout: 60000 }, async () => {
    for (const [startup, precision, beforeDecode, afterDecode] of [
      ['low', 'low', 'high', 'normal'],
      ['high', 'high', 'low', 'normal'],
      ['unknown', 'normal', 'high', 'low'],
    ] as const) {
      await using(binary, async (f) => {
        assert.equal(await f.session.evaluate('System.getArgument("-jpegdec")'), startup)
        assert.equal(f.requests.length, 0)
        assert.equal(await f.session.evaluate(`jpegSetPrecision(${JSON.stringify(beforeDecode)})`), beforeDecode)
        assert.equal(await f.load('gray64.jpg'), 'ok')
        assert.equal(await f.session.evaluate('jpegPixels(jpegImage)'), jpegRgba(64).join(','))
        assert.deepEqual(f.requests.map(({ mode, precision }) => ({ mode, precision })), [{ mode: 'normal', precision }])
        assert.equal(await f.session.evaluate(`jpegSetPrecision(${JSON.stringify(afterDecode)})`), afterDecode)
        assert.equal(await f.load('mask64.jpg'), 'ok')
        assert.equal(await f.session.evaluate('jpegPixels(jpegImage)'), jpegRgba(255, 64).join(','))
        // Constant DC pixels confirm real decoding, not a measurable precision
        // difference. Startup precision is checked at the provider boundary.
        assert.deepEqual(f.requests.map(({ mode, precision }) => ({ mode, precision })), [
          { mode: 'normal', precision }, { mode: 'normal', precision }, { mode: 'grayscale', precision },
        ])
      }, startup)
    }
  })
  test(`${mode}: fixed JPEG main and grayscale mask bytes remain private across processed cache destinations`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      const id = Number(await f.session.evaluate('jpegImage.__id'))
      for (const [name, value, alpha] of [
        ['gray0.jpg', 0, 255], ['gray64.jpg', 64, 255], ['gray255.jpg', 255, 255],
        ['mask0.jpg', 255, 0], ['mask64.jpg', 255, 64], ['mask255.jpg', 64, 255],
      ] as const) {
        const expected = jpegRgba(value, alpha)
        assert.equal(await f.load(name), 'ok')
        assert.equal(await f.session.evaluate('jpegPixels(jpegImage)'), expected.join(','))
        const opened = f.opened(), hits = f.session.snapshot().imageCacheHits
        assert.equal(await f.load(name, 'clNone', 'jpegCopy'), 'ok')
        assert.equal(f.session.snapshot().imageCacheHits, hits + 1)
        await f.session.evaluate('(jpegImage.setMainPixel(0,0,0xabcdef),jpegImage.setMaskPixel(0,0,19),0)')
        assert.equal(await f.session.evaluate('jpegPixels(jpegCopy)'), expected.join(','))
        assert.equal(await f.load(name), 'ok')
        assert.equal(f.opened(), opened, 'Finished cache hits never reopen the native JPEG decoder')
        assert.deepEqual(f.frames.at(-1)!.find((layer) => layer.id === id)!.data, expected)
        assert.equal(f.reads.get(name), 1)
      }
      const before = f.session.snapshot().imageCacheEntries
      assert.equal(await f.load('gray64.jpg', '0x404040'), 'ok')
      assert.equal(await f.session.evaluate('jpegPixels(jpegImage)'), jpegRgba(64, 0).join(','))
      assert.equal(f.session.snapshot().imageCacheEntries, before + 1)
      assert.equal(await f.load('gray64.jpg'), 'ok')
      assert.equal(await f.session.evaluate('jpegPixels(jpegImage)'), jpegRgba(64).join(','))
      assert.equal(f.requests.filter((request) => request.mode === 'grayscale').length, 3)
      assert(f.requests.every((request) => request.precision === 'normal'))
    })
  })
  test(`${mode}: JPEG numeric holders distinguish codec failure, provider failure and recoverable source EOF`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      const codes = jpegErrorCodes()
      assert.equal(await f.load('gray64.jpg'), 'ok')
      for (const [name, code] of [['no-soi.jpg', codes.NO_SOI!], ['empty.jpg', codes.INPUT_EMPTY!]] as const) {
        const before = f.session.snapshot().imageCacheEntries
        for (let attempt = 1; attempt <= 2; attempt++) {
          assert.equal(await f.load(name), jpegError(code))
          assert.equal(await f.session.evaluate('jpegPixels(jpegImage)'), jpegRgba(64).join(','))
          assert.equal(f.session.snapshot().imageCacheEntries, before)
          assert.equal(f.reads.get(name), attempt)
          assert.equal(f.active(), 0)
        }
      }
      assert.equal(await f.load('unsupported-mask.jpg'), jpegError(codes.CONVERSION_NOTIMPL!))
      assert.equal(await f.session.evaluate('jpegPixels(jpegImage)'), jpegRgba(255).join(','), 'Failed grayscale conversion leaves completed normal main bytes')
      f.failNext(new Error('owned JPEG source provider failure'))
      assert.equal(await f.load('gray64-eof.jpg'), 'owned JPEG source provider failure', 'External provider errors are not relabeled as native JPEG or TJSReadError')
      assert.equal(await f.load('gray64-eof.jpg'), 'ok')
      assert.equal(await f.session.evaluate('jpegPixels(jpegImage)'), jpegRgba(64).join(','), 'Missing EOI recovers complete authored DC pixels')
      assert(f.requests.at(-1)!.warnings > 0)
      assert.equal(f.requests.at(-1)!.warningCode, codes.JPEG_EOF)
      assert.equal(f.reads.get('gray64-eof.jpg'), 2)
      assert.equal(f.active(), 0); assert.equal(f.opened(), f.closed())
    })
  })
  test(`${mode}: paused JPEG provider admission makes no native step until the original Session resumes`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      const gate = f.gateNext(), pending = settled(f.load('gray64.jpg'))
      await within(Promise.race([gate.entered.promise, pending.then(() => { throw new Error('JPEG settled before admission gate') })]), 'real JPEG open')
      f.session.pause()
      const before = f.frames.length
      gate.release.resolve(); await within(gate.delivered.promise, 'held native decoder delivery')
      await new Promise<void>((done) => setTimeout(done, 0))
      assert.equal(f.steps(), 0)
      assert.equal(f.session.snapshot().state, 'paused')
      assert.equal(f.frames.length, before)
      f.session.resume()
      assert.deepEqual(await within(pending, 'JPEG resume'), { status: 'fulfilled', value: 'ok' })
      assert.equal(await f.session.evaluate('jpegPixels(jpegImage)'), jpegRgba(64).join(','))
      assert(f.steps() > 0); assert.equal(f.closed(), 1)
    })
  })
  test(`${mode}: Stop retires a real opened JPEG decoder before its late provider result can publish`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      const gate = f.gateNext(), pending = settled(f.session.evaluate('(jpegLoad(jpegImage,"gray64.jpg",clNone),Debug.message("jpeg-after-stop"),0)'))
      await within(Promise.race([gate.entered.promise, pending.then(() => { throw new Error('JPEG settled before admission gate') })]), 'real JPEG open')
      await within(f.session.stop(), 'Stop before releasing the JPEG provider')
      assert.equal(f.session.snapshot().state, 'stopped')
      assert.equal(f.active(), 0); assert.equal(f.closed(), 1); assert.equal(f.steps(), 0)
      const result = await within(pending, 'cancelled TJS load')
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') {
        assert(result.reason instanceof Error)
        assert.equal(result.reason.name, 'AbortError'); assert.equal(result.reason.message, 'Execution cancelled')
      }
      gate.release.resolve(); await within(gate.delivered.promise, 'late JPEG provider completion')
      await new Promise<void>((done) => setTimeout(done, 0))
      assert.equal(f.steps(), 0); assert.equal(f.closed(), 1)
      assert.equal(f.session.snapshot().bitmapBytes, 0)
      assert.equal(f.session.snapshot().imageCacheEntries, 0)
      assert.equal(f.logs.includes('jpeg-after-stop'), false)
    })
  })
}
