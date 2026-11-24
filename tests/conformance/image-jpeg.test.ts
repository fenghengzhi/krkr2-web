import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { ImageJpegKernel, type ImageJpegModule } from '../../src/backends/image-jpeg/kernel.ts'
import { instantiateImageJpegKernel, validateImageJpegManifest, type ImageJpegFactory,
  type ImageJpegManifest } from '../../src/backends/image-jpeg/module.ts'
import { LazyImageJpegProvider } from '../../src/engine/graphics/image-jpeg-provider.ts'
import { decodeSelectedImage, type SelectedImageDecoderDependencies } from '../../src/engine/graphics/image-decoder.ts'
import { ImageDecodeError } from '../../src/formats/image/selection.ts'
import type { ImageJpegDecoder, ImageJpegMode, ImageJpegPrecision, ImageJpegStep } from '../../src/engine/ports/image-jpeg.ts'
import { ExecutionControl, ExecutionCancelled } from '../../src/engine/scheduler/control.ts'
import { jpegFixture, jpegErrorCodes } from '../helpers/jpeg-contract.ts'

const options = { timeout: 60000 }, directory = resolve('.generated/image-jpeg'),
  manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as ImageJpegManifest
validateImageJpegManifest(manifest)
for (const kind of ['mjs', 'wasm'] as const) {
  const entry = manifest.assets[kind], bytes = readFileSync(resolve(directory, entry.file))
  assert.equal(bytes.length, entry.bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256)
}
const { default: factory } = await import(pathToFileURL(resolve(directory, manifest.assets.mjs.file)).href) as { default: ImageJpegFactory },
  wasmBinary = new Uint8Array(readFileSync(resolve(directory, manifest.assets.wasm.file)))

async function fixture(allocationLimit?: number) {
  const module = await factory({ wasmBinary }), kernel = new ImageJpegKernel(module, { allocationLimit })
  return { module, kernel, close() {
    kernel.dispose(); kernel.dispose()
    assert.equal(kernel.inspect().active, 0); assert.equal(kernel.inspect().allocatedBytes, 0)
    assert.equal(module._image_jpeg_stat(0), 0); assert.equal(module._image_jpeg_stat(1), 0)
  } }
}
async function using(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>, allocationLimit?: number) {
  const value = await fixture(allocationLimit), errors: unknown[] = []
  try { await run(value) } catch (error) { errors.push(error) }
  try { value.close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'JPEG work and cleanup failed', { cause: errors[0] })
}
function pull(decoder: ImageJpegDecoder, bytes: Uint8Array, window = 8192) {
  const events: ImageJpegStep[] = [], rgba: number[] = []
  let at = 0, needs = true, width = 0, height = 0, rows = 0
  for (let count = 0; count < 100000; count++) {
    const input = needs ? bytes.subarray(at, at + window) : new Uint8Array(),
      step = decoder.step(input, at + input.length === bytes.length)
    assert.ok(step.inputUsed >= 0 && step.inputUsed <= input.length)
    at += step.inputUsed; needs = step.needsInput; events.push(step)
    if (step.status === 'size') {
      assert.equal(width, 0); width = step.width!; height = step.height!
    } else if (step.status === 'rows') {
      assert.equal(step.startRow, rows); assert.equal(step.data!.length, width * 4 * step.rowCount!)
      rows += step.rowCount!; rgba.push(...step.data!)
    }
    if (['done', 'codec-error', 'budget-error'].includes(step.status)) return { terminal: step, events, rgba, at, width, height, rows }
  }
  throw new Error('JPEG fixture exhausted its step bound')
}
function decode(kernel: ImageJpegKernel, bytes: Uint8Array, mode: ImageJpegMode = 'normal',
  precision: ImageJpegPrecision = 'normal', window = 8192) {
  const decoder = kernel.open(mode, precision)
  try { return pull(decoder, bytes, window) } finally { decoder.close() }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('configured real IJG produces independently authored constant DC pixels in every precision and native gray mode', options, async () => {
  await using(async ({ kernel }) => {
    for (const value of [0, 64, 255]) for (const mode of ['normal', 'grayscale'] as const)
      for (const precision of ['low', 'normal', 'high'] as const) {
        const result = decode(kernel, jpegFixture('constant-gray' + value), mode, precision)
        assert.equal(result.terminal.status, 'done'); assert.equal(result.terminal.phase, 'complete')
        assert.deepEqual([result.width, result.height, result.rows], [8, 8, 8])
        assert.deepEqual(result.rgba, Array.from({ length: 64 }, () => [value, value, value, 255]).flat())
        assert.equal(result.terminal.warnings.count, 0)
      }
  })
})

test('marker skips, entropy rollback and progressive preload preserve pixels across real input partitions', options, async () => {
  await using(async ({ kernel }) => {
    const padded = jpegFixture('padding-normal')
    assert.ok(padded.length > 8192, 'The independent APP marker must cross the original Read window')
    for (const id of ['padding-normal', 'restart-normal', 'progressive-normal']) {
      const input = jpegFixture(id), baseline = decode(kernel, input)
      assert.equal(baseline.terminal.status, 'done')
      for (const window of id === 'padding-normal' ? [97, 4095] : [1, 17, 257]) {
        const split = decode(kernel, input, 'normal', 'normal', window)
        assert.equal(split.terminal.status, 'done')
        assert.deepEqual(split.rgba, baseline.rgba, `${id}/${window}: source partition must not alter decoding`)
        assert.deepEqual(split.terminal.warnings, baseline.terminal.warnings)
        assert.deepEqual(split.events.filter((step) => step.status === 'rows').map((step) => [step.startRow, step.rowCount]),
          baseline.events.filter((step) => step.status === 'rows').map((step) => [step.startRow, step.rowCount]))
        assert.ok(split.events.some((step) => step.status === 'progress' && step.needsInput))
      }
    }
  })
})

test('low two-row groups and late finish errors retain the original public publication boundary', options, async () => {
  await using(async ({ kernel }) => {
    const low = decode(kernel, jpegFixture('y420-low'), 'normal', 'low', 7),
      complete = decode(kernel, jpegFixture('y420-normal')),
      failure = decode(kernel, jpegFixture('tail-duplicate-soi'), 'normal', 'normal', 13),
      early = decode(kernel, jpegFixture('progressive-duplicate-soi'), 'normal', 'normal', 13), codes = jpegErrorCodes()
    assert.equal(low.terminal.status, 'done')
    assert.deepEqual(low.events.filter((step) => step.status === 'rows').map((step) => step.rowCount), [...Array<number>(9).fill(2), 1])
    assert.equal(failure.terminal.status, 'codec-error'); assert.equal(failure.terminal.code, codes.SOI_DUPLICATE)
    assert.equal(failure.terminal.phase, 'finish'); assert.equal(failure.rows, 19)
    assert.deepEqual(failure.rgba, complete.rgba)
    assert.equal(early.terminal.status, 'codec-error'); assert.equal(early.terminal.phase, 'start')
    assert.equal(early.terminal.code, codes.SOI_DUPLICATE)
    assert.equal(early.width, 0); assert.equal(early.rows, 0)
  })
})

test('empty and unsupported color inputs keep numeric native errors while missing EOI uses real warning recovery', options, async () => {
  await using(async ({ kernel }) => {
    const codes = jpegErrorCodes()
    for (const [id, mode, code] of [['empty', 'normal', codes.INPUT_EMPTY], ['not-jpeg', 'normal', codes.NO_SOI],
      ['rgb-gray', 'grayscale', codes.CONVERSION_NOTIMPL]] as const) {
      const result = decode(kernel, jpegFixture(id), mode)
      assert.equal(result.terminal.status, 'codec-error'); assert.equal(result.terminal.code, code)
      assert.equal(result.width, 0); assert.equal(result.rows, 0)
    }
    const full = decode(kernel, jpegFixture('y420-normal')), recovered = decode(kernel, jpegFixture('missing-eoi'), 'normal', 'normal', 17)
    assert.equal(recovered.terminal.status, 'done'); assert.deepEqual(recovered.rgba, full.rgba)
    assert.ok(recovered.terminal.warnings.count > 0); assert.equal(recovered.terminal.warnings.lastCode, codes.JPEG_EOF)
  })
})

test('64 live decoders grow real memory without changing owned rows, and stale native tokens cannot target replacements', options, async () => {
  await using(async ({ module, kernel }) => {
    const initialHeap = module.HEAPU8.buffer, streams = Array.from({ length: 64 }, () => kernel.open('normal', 'normal'))
    assert.equal(kernel.inspect().active, 64); assert.notEqual(module.HEAPU8.buffer, initialHeap)
    assert.throws(() => kernel.open('normal', 'normal'), /64 active decoders/)
    const saved: { bytes: Uint8Array; value: number }[] = []
    for (let i = 0; i < streams.length; i++) {
      const value = [0, 64, 255][i % 3]!, result = pull(streams[i]!, jpegFixture('constant-gray' + value))
      assert.equal(result.terminal.status, 'done')
      for (const row of result.events.filter((step) => step.status === 'rows')) {
        assert.notEqual(row.data!.buffer, module.HEAPU8.buffer); saved.push({ bytes: row.data!, value })
      }
    }
    for (const { bytes, value } of saved)
      assert.deepEqual([...bytes], Array.from({ length: bytes.length / 4 }, () => [value, value, value, 255]).flat())
    streams.forEach((stream) => stream.close())
    const old = module._image_jpeg_open(0, 1, 128 * 1024 * 1024) >>> 0
    assert.notEqual(old, 0); assert.equal(module._image_jpeg_close(old), 0)
    const replacement = module._image_jpeg_open(0, 1, 128 * 1024 * 1024) >>> 0
    assert.notEqual(replacement, 0); assert.notEqual(replacement, old)
    assert.equal(module._image_jpeg_step(old, 0, 1), -1)
    assert.equal(module._image_jpeg_close(old), 0); assert.equal(kernel.inspect().active, 1)
    assert.equal(module._image_jpeg_close(replacement), 0)
    assert.throws(() => streams[0]!.step(new Uint8Array(), true), /closed/)
  })
})

test('imposed allocation failures stay separate from codec numbers and release partial initialization', options, async () => {
  await using(async ({ kernel }) => {
    assert.throws(() => kernel.open('normal', 'normal'), /allocation budget/)
    assert.equal(kernel.inspect().active, 0); assert.equal(kernel.inspect().allocatedBytes, 0)
  }, 0)
  await using(async ({ kernel }) => {
    const stream = kernel.open('normal', 'normal'), result = pull(stream, jpegFixture('y420-normal'))
    assert.equal(result.terminal.status, 'budget-error'); assert.equal(result.terminal.code, undefined)
    assert.match(result.terminal.budgetReason!, /allocation budget/)
    assert.equal(result.width, 0); assert.equal(result.rows, 0)
    stream.close(); assert.equal(kernel.inspect().allocatedBytes, 0)
  }, 74 * 1024)
})

test('simultaneous real modules retain separate pools and continue after the other owner is disposed', options, async () => {
  const a = await fixture(), b = await fixture(), errors: unknown[] = []
  try {
    assert.notEqual(a.module.HEAPU8.buffer, b.module.HEAPU8.buffer)
    assert.throws(() => new ImageJpegKernel(a.module), /already has a kernel owner/)
    const suspended = a.kernel.open('normal', 'normal')
    suspended.step(jpegFixture('y420-normal').subarray(0, 17), false)
    const active = b.kernel.open('grayscale', 'normal')
    a.close(); assert.throws(() => suspended.step(new Uint8Array(), true), /closed/)
    assert.equal(b.kernel.inspect().active, 1)
    const result = pull(active, jpegFixture('constant-gray64'), 3)
    assert.equal(result.terminal.status, 'done'); assert.ok(result.rgba.every((byte, at) => byte === (at % 4 === 3 ? 255 : 64)))
    active.close()
  } catch (error) { errors.push(error) }
  for (const f of [a, b]) try { f.close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Independent JPEG modules failed', { cause: errors[0] })
})

test('lazy provider shares one failed load without swallowing it, then retries a real kernel and closes both streams', options, async () => {
  const f = await fixture(), control = new ExecutionControl(), failure = new Error('original JPEG load failure'), errors: unknown[] = []
  let loads = 0
  const provider = new LazyImageJpegProvider(async () => { if (++loads === 1) throw failure; return f.kernel }, () => control),
    input = jpegFixture('constant-gray64')
  try {
    const first = await Promise.allSettled([provider.open(input, 'normal', 'normal'), provider.open(input, 'normal', 'normal')])
    for (const result of first) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason, failure) }
    assert.equal(loads, 1)
    const [a, b] = await Promise.all([provider.open(input, 'normal', 'normal'), provider.open(input, 'grayscale', 'high')])
    assert.equal(loads, 2); assert.equal(f.kernel.inspect().active, 2)
    assert.equal(pull(a, input).terminal.status, 'done'); assert.equal(pull(b, input).terminal.status, 'done')
    provider.dispose(); provider.dispose()
    assert.equal(f.kernel.inspect().allocatedBytes, 0)
    await assert.rejects(provider.open(input, 'normal', 'normal'), ExecutionCancelled)
    const bad = structuredClone(manifest); bad.source.originalHeaders['jmorecfg.h']!.sha256 = '0'.repeat(64)
    assert.throws(() => validateImageJpegManifest(bad), /configuration mismatch/)
  } catch (error) { errors.push(error) }
  try { provider.dispose(); f.close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'JPEG provider retry and cleanup failed', { cause: errors[0] })
})

test('cancelled real module initialization remains observed and retires the late module before it can escape', options, async () => {
  const control = new ExecutionControl(), entered = deferred<void>(), release = deferred<void>(), retired = deferred<void>()
  let module: ImageJpegModule | undefined
  const errors: unknown[] = []
  const delayed: ImageJpegFactory = async (parameters) => {
    let loaded: ImageJpegModule
    try { loaded = await factory(parameters) }
    catch (error) { entered.reject(error); retired.resolve(undefined); throw error }
    module = loaded
    const dispose = loaded._image_jpeg_dispose.bind(loaded)
    loaded._image_jpeg_dispose = () => { dispose(); retired.resolve(undefined) }
    entered.resolve(undefined); await release.promise
    return loaded
  }, pending = instantiateImageJpegKernel(delayed, { wasmBinary }, control)
  void pending.catch(() => {})
  try {
    await entered.promise; control.cancel()
    await assert.rejects(pending, ExecutionCancelled)
  } catch (error) { errors.push(error) }
  release.resolve(undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([retired.promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Late JPEG module was not retired')), 5000)
    })])
    if (module) { assert.equal(module._image_jpeg_stat(0), 0); assert.equal(module._image_jpeg_stat(1), 0) }
  } catch (error) { errors.push(error) }
  finally { clearTimeout(timer) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'JPEG initialization cancellation and cleanup failed', { cause: errors[0] })
})

test('real JPEG decoding preserves provider and row callback identities, including a secondary close failure', options, async () => {
  await using(async ({ kernel }) => {
    const bytes = jpegFixture('constant-gray64'), failure = new ImageDecodeError('jpeg', 'typed-looking external failure'),
      cleanup = new Error('secondary JPEG close failure'), dependencies: SelectedImageDecoderDependencies = {
        async finish<T>(work: Generator<void, T>) {
          try { for (let i = 0; i < 100000; i++) { const next = work.next(); if (next.done) return next.value } }
          finally { work.return(undefined as T) }
          throw new Error('JPEG fixture exceeded step bound')
        },
        async inflate() { throw new Error('JPEG must not use PNG inflation') },
        async host() { throw new Error('JPEG must not use browser decoding') },
        async openJpeg(_source, mode) { return kernel.open(mode, 'normal') },
      }
    await assert.rejects(decodeSelectedImage(bytes, { format: 'jpeg', mode: 'normal' },
      { ...dependencies, async openJpeg() { throw failure } }), (error) => error === failure)
    let rows = 0
    await assert.rejects(decodeSelectedImage(bytes, { format: 'jpeg', mode: 'normal' }, dependencies,
      { size() {}, row() { rows++; throw failure } }), (error) => error === failure)
    assert.equal(rows, 1); assert.equal(kernel.inspect().active, 0)
    await assert.rejects(decodeSelectedImage(bytes, { format: 'jpeg', mode: 'normal' }, {
      ...dependencies, async openJpeg(_source, mode) {
        const stream = kernel.open(mode, 'normal')
        return { step: (input, eof) => stream.step(input, eof), close() { stream.close(); throw cleanup } }
      },
    }, { size() { throw failure }, row() { throw new Error('A rejected size must prevent rows') } }), (error: unknown) => {
      assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [failure, cleanup]); assert.equal(error.cause, failure)
      return true
    })
    assert.equal(kernel.inspect().active, 0); assert.equal(kernel.inspect().allocatedBytes, 0)
  })
})
