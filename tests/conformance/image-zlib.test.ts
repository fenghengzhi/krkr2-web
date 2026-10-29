import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { ImageZlibKernel, type ImageZlibModule } from '../../src/backends/image-zlib/kernel.ts'
import { instantiateImageZlibKernel, validateImageZlibManifest, type ImageZlibFactory,
  type ImageZlibManifest } from '../../src/backends/image-zlib/module.ts'
import { ExecutionControl, ExecutionCancelled } from '../../src/engine/scheduler/control.ts'
import type { ImageInflater } from '../../src/engine/ports/image-inflater.ts'
import { LazyImageInflaterProvider } from '../../src/engine/graphics/image-inflater-provider.ts'

const options = { timeout: 30_000 }, directory = resolve(process.env.KRKR_IMAGE_ZLIB_DIR ?? '.generated/image-zlib'),
  manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as ImageZlibManifest
validateImageZlibManifest(manifest)
for (const kind of ['mjs', 'wasm'] as const) {
  const bytes = readFileSync(resolve(directory, manifest.assets[kind].file))
  assert.equal(bytes.length, manifest.assets[kind].bytes)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.assets[kind].sha256)
}
const { default: factory } = await import(pathToFileURL(resolve(directory, manifest.assets.mjs.file)).href) as { default: ImageZlibFactory },
  wasmBinary = new Uint8Array(readFileSync(resolve(directory, manifest.assets.wasm.file)))

async function fixture(allocationLimit?: number) {
  const module = await factory({ wasmBinary }), kernel = new ImageZlibKernel(module, { allocationLimit })
  return { module, kernel, close() {
    kernel.dispose()
    assert.equal(kernel.inspect().active, 0)
    assert.equal(kernel.inspect().allocatedBytes, 0)
    assert.equal(module._image_zlib_stat(0), 0)
    assert.equal(module._image_zlib_stat(1), 0)
  } }
}
async function using(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, allocationLimit?: number) {
  const f = await fixture(allocationLimit), errors: unknown[] = []
  try { await run(f) } catch (error) { errors.push(error) }
  try { f.close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Image zlib work and cleanup failed', { cause: errors[0] })
}
function pull(stream: ImageInflater, bytes: Uint8Array, inputWindow = 3, outputWindow = 5) {
  const result: number[] = []
  let position = 0
  for (let step = 0; step < 100_000; step++) {
    const input = bytes.subarray(position, position + inputWindow), output = new Uint8Array(outputWindow + 4).fill(0xa5),
      view = output.subarray(2, outputWindow + 2), observed = stream.step(input, view)
    assert.ok(observed.inputUsed >= 0 && observed.inputUsed <= input.length)
    assert.ok(observed.outputUsed >= 0 && observed.outputUsed <= view.length)
    assert.deepEqual([...output.subarray(0, 2)], [0xa5, 0xa5])
    assert.deepEqual([...output.subarray(outputWindow + 2)], [0xa5, 0xa5])
    assert.ok(view.subarray(observed.outputUsed).every((byte) => byte === 0xa5))
    position += observed.inputUsed
    result.push(...view.subarray(0, observed.outputUsed))
    if (observed.status === 'end') return { bytes: Uint8Array.from(result), consumed: position }
    assert.equal(observed.status, 'ok', observed.nativeReason)
    assert.ok(observed.inputUsed || observed.outputUsed, 'An ok call must make progress with available input/output')
  }
  throw new Error('Image inflater did not terminate within the fixture step bound')
}

test('real image zlib pull retains consumed suffixes, bounds each row write and leaves trailing input unread', options, async () => {
  await using(async ({ kernel }) => {
    const expected = Uint8Array.from({ length: 1024 }, (_, i) => (i * 37 + (i >>> 3)) & 255),
      compressed = deflateSync(expected), bytes = Buffer.concat([compressed, Buffer.from([201, 202, 203, 204])]),
      stream = kernel.open(), result = pull(stream, bytes)
    assert.deepEqual(result.bytes, expected)
    assert.equal(result.consumed, compressed.length)
    assert.equal(kernel.inspect().active, 1)
    assert.ok(kernel.inspect().allocatedBytes > 0)
    stream.close(); stream.close()
    assert.equal(kernel.inspect().active, 0)
    assert.equal(kernel.inspect().allocatedBytes, 0)
  })
})

test('a bad zlib Adler exposes exact produced bytes and data-error without converting it to a success', options, async () => {
  await using(async ({ kernel }) => {
    const expected = Uint8Array.from({ length: 32 }, (_, i) => 40 + i), compressed = deflateSync(expected, { level: 0 })
    compressed[compressed.length - 1] = compressed[compressed.length - 1]! ^ 1
    const stream = kernel.open(), output = new Uint8Array(64).fill(0xa5), observed = stream.step(compressed, output)
    assert.equal(observed.status, 'data-error')
    assert.equal(observed.nativeReason, 'incorrect data check')
    assert.equal(observed.inputUsed, compressed.length)
    assert.equal(observed.outputUsed, expected.length)
    assert.deepEqual(output.subarray(0, observed.outputUsed), expected)
    assert.ok(output.subarray(observed.outputUsed).every((byte) => byte === 0xa5))
    stream.close()
  })
})

test('dictionary and malformed-header states expose distinct native statuses without output', options, async () => {
  await using(async ({ kernel }) => {
    const dictionary = Buffer.from('reusable PNG dictionary is deliberately unsupported'),
      encoded = deflateSync(Buffer.from('reusable PNG dictionary'), { dictionary }), stream = kernel.open(), output = new Uint8Array(64).fill(0xa5),
      needs = stream.step(encoded, output)
    assert.equal(needs.status, 'need-dictionary')
    assert.equal(needs.nativeReason, undefined)
    assert.equal(needs.inputUsed, 6)
    assert.equal(needs.outputUsed, 0)
    assert.ok(output.every((byte) => byte === 0xa5))
    stream.close()
    const malformed = kernel.open(), bad = malformed.step(Uint8Array.of(0, 0), output)
    assert.equal(bad.status, 'data-error')
    assert.equal(bad.nativeReason, 'incorrect header check')
    assert.equal(bad.outputUsed, 0)
    malformed.close()
  })
})

test('empty input and truncated trailers remain explicit buffer-error states, not inferred stream end', options, async () => {
  await using(async ({ kernel }) => {
    const stream = kernel.open(), empty = stream.step(new Uint8Array(), new Uint8Array(16))
    assert.deepEqual(empty, { inputUsed: 0, outputUsed: 0, status: 'buffer-error' })
    const payload = Uint8Array.from([10, 20, 30, 40]), encoded = deflateSync(payload, { level: 0 }),
      output = new Uint8Array(32), partial = stream.step(encoded.subarray(0, encoded.length - 4), output)
    assert.equal(partial.status, 'ok')
    assert.equal(partial.outputUsed, payload.length)
    assert.deepEqual(output.subarray(0, partial.outputUsed), payload)
    const end = stream.step(new Uint8Array(), output)
    assert.equal(end.status, 'buffer-error')
    assert.equal(end.inputUsed, 0); assert.equal(end.outputUsed, 0)
    stream.close()
  })
})

test('64 real concurrent streams share only scratch storage and all close with zero native allocations', options, async () => {
  await using(async ({ module, kernel }) => {
    const streams = Array.from({ length: 64 }, () => kernel.open()), initialHeap = module.HEAPU8.buffer,
      pending: { payload: Uint8Array; encoded: Uint8Array; inputUsed: number; prefix: number }[] = []
    assert.equal(kernel.inspect().active, 64)
    assert.throws(() => kernel.open(), /64 active streams/)
    for (let i = 0; i < streams.length; i++) {
      const payload = Uint8Array.of(i, 255 - i, i ^ 0x55), encoded = deflateSync(payload), output = new Uint8Array(1),
        first = streams[i]!.step(encoded, output)
      assert.equal(first.status, 'ok'); assert.equal(first.outputUsed, 1)
      pending.push({ payload, encoded, inputUsed: first.inputUsed, prefix: output[0]! })
    }
    // 64 live sliding windows exceed the module's 2-MiB initial heap.
    assert.notEqual(module.HEAPU8.buffer, initialHeap)
    for (let i = 0; i < streams.length; i++) {
      const item = pending[i]!, result = pull(streams[i]!, item.encoded.subarray(item.inputUsed), 8192, 16)
      assert.deepEqual(Uint8Array.from([item.prefix, ...result.bytes]), item.payload)
    }
    for (let i = 0; i < streams.length; i += 2) streams[i]!.close()
    const replacement = kernel.open()
    streams[0]!.close()
    assert.throws(() => streams[0]!.step(new Uint8Array(), new Uint8Array(1)), /closed/)
    assert.deepEqual(pull(replacement, deflateSync(Uint8Array.of(77))).bytes, Uint8Array.of(77))
    assert.equal(kernel.inspect().active, 33)
    kernel.dispose(); kernel.dispose()
    assert.throws(() => replacement.step(new Uint8Array(), new Uint8Array(1)), /closed/)
    assert.throws(() => kernel.open(), /disposed/)
  })
})

test('allocation failures at initialization and lazy window creation preserve native accounting', options, async () => {
  await using(async ({ kernel }) => {
    assert.throws(() => kernel.open(), /initialization failed \(-4\)/)
    assert.equal(kernel.inspect().active, 0); assert.equal(kernel.inspect().allocatedBytes, 0)
  }, 0)
  await using(async ({ kernel }) => {
    const stream = kernel.open(), payload = new Uint8Array(1024).fill(61), encoded = deflateSync(payload, { level: 0 }),
      output = new Uint8Array(1), observed = stream.step(encoded, output)
    // inflateInit fits this bound; the later 32-KiB sliding window does not.
    assert.equal(observed.status, 'memory-error')
    assert.equal(observed.nativeReason, undefined)
    assert.equal(observed.outputUsed, 1); assert.equal(output[0], 61)
    assert.ok(kernel.inspect().allocatedBytes > 0)
    stream.close()
    assert.equal(kernel.inspect().allocatedBytes, 0)
  }, 16 * 1024)
})

test('simultaneously live WASM modules remain independent after disposing the other kernel', options, async () => {
  const a = await fixture(), b = await fixture(), errors: unknown[] = []
  try {
    assert.notEqual(a.module.HEAPU8.buffer, b.module.HEAPU8.buffer)
    const as = a.kernel.open(), bs = b.kernel.open(), payload = new Uint8Array(64).fill(92), encoded = deflateSync(payload),
      prefix = new Uint8Array(1), first = bs.step(encoded, prefix)
    assert.equal(first.status, 'ok'); assert.equal(first.outputUsed, 1); assert.equal(prefix[0], 92)
    assert.deepEqual(pull(as, deflateSync(Uint8Array.of(13, 14))).bytes, Uint8Array.of(13, 14))
    a.close()
    assert.equal(b.kernel.inspect().active, 1)
    const suffix = pull(bs, encoded.subarray(first.inputUsed), 8192, 8)
    assert.deepEqual(Uint8Array.from([prefix[0]!, ...suffix.bytes]), payload)
    bs.close()
  } catch (error) { errors.push(error) }
  try { a.close() } catch (error) { errors.push(error) }
  try { b.close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Independent image modules or cleanup failed', { cause: errors[0] })
})

test('invalid buffer/owner operations fail before consuming a live native stream', options, async () => {
  await using(async ({ module, kernel }) => {
    assert.throws(() => new ImageZlibKernel(module), /already has a kernel owner/)
    const stream = kernel.open()
    assert.throws(() => stream.step(new Uint8Array(8193), new Uint8Array(1)), RangeError)
    assert.throws(() => stream.step(new Uint8Array(), new Uint8Array(32770)), RangeError)
    assert.throws(() => stream.step(module.HEAPU8.subarray(1, 2), new Uint8Array(1)), /caller-owned/)
    assert.throws(() => stream.step(new Uint8Array(), module.HEAPU8.subarray(1, 2)), /caller-owned/)
    const overlap = new Uint8Array(4)
    assert.throws(() => stream.step(overlap.subarray(0, 3), overlap.subarray(2)), /must not overlap/)
    assert.deepEqual(pull(stream, deflateSync(Uint8Array.of(5, 6, 7))).bytes, Uint8Array.of(5, 6, 7))
    stream.close()
    assert.throws(() => stream.step(new Uint8Array(), new Uint8Array(1)), /closed/)
  })
})

test('cancelled module creation observes the late real factory and retires its native owner', options, async () => {
  const control = new ExecutionControl()
  let release!: (module: ImageZlibModule) => void, entered!: () => void
  const enteredGate = new Promise<void>((resolve) => { entered = resolve }),
    late = new Promise<ImageZlibModule>((resolve) => { release = resolve }),
    pending = instantiateImageZlibKernel(async () => { entered(); return late }, { wasmBinary }, control)
  const failed = assert.rejects(pending, ExecutionCancelled)
  await enteredGate
  control.cancel()
  await failed
  const module = await factory({ wasmBinary })
  let retired!: () => void
  const retiredGate = new Promise<void>((resolve) => { retired = resolve }), dispose = module._image_zlib_dispose.bind(module)
  module._image_zlib_dispose = () => { dispose(); retired() }
  release(module)
  await retiredGate
  assert.equal(module._image_zlib_stat(0), 0)
  assert.equal(module._image_zlib_stat(1), 0)
  // Retired late ownership does not leave the module locked in the WeakSet.
  const next = new ImageZlibKernel(module)
  const stream = next.open(); stream.close(); next.dispose()
  assert.equal(module._image_zlib_stat(1), 0)
})

test('image zlib manifests reject wrong ABI, source identity and asset hashes before loading', options, () => {
  for (const mutate of [
    (value: ImageZlibManifest) => { (value as { abi: number }).abi = 2 },
    (value: ImageZlibManifest) => { value.source.archiveSha512 = '0'.repeat(128) },
    (value: ImageZlibManifest) => { value.assets.wasm.file = '../wrong.wasm' },
    (value: ImageZlibManifest) => { value.assets.wasm.sha256 = '0'.repeat(64) },
    (value: ImageZlibManifest) => { value.assets.wasm.bytes = 0 },
  ]) {
    const value = structuredClone(manifest)
    mutate(value)
    assert.throws(() => validateImageZlibManifest(value), /Image zlib|Invalid image zlib/)
  }
})

test('a failed provider initialization preserves its error then retries once and shares the real kernel', options, async () => {
  const control = new ExecutionControl(), original = new Error('first image module load failed'), failures: unknown[] = [],
    loaded: { kernel?: ImageZlibKernel } = {}
  let loads = 0
  const provider = new LazyImageInflaterProvider(async () => {
    loads++
    if (loads === 1) throw original
    loaded.kernel = await instantiateImageZlibKernel(factory, { wasmBinary }, control)
    return loaded.kernel
  }, () => control), payload = Uint8Array.of(23, 24, 25), source = deflateSync(payload)
  try {
    await assert.rejects(provider.open(source, payload.length), (error: unknown) => error === original)
    assert.equal(loads, 1)
    const [a, b] = await Promise.all([provider.open(source, payload.length), provider.open(source, payload.length)])
    assert.equal(loads, 2)
    const kernel = loaded.kernel
    assert.ok(kernel)
    assert.equal(kernel.inspect().active, 2)
    assert.deepEqual(pull(a, source).bytes, payload)
    assert.deepEqual(pull(b, source).bytes, payload)
    provider.dispose(); provider.dispose()
    assert.equal(kernel.inspect().active, 0); assert.equal(kernel.inspect().allocatedBytes, 0)
    assert.throws(() => a.step(new Uint8Array(), new Uint8Array(1)), /closed/)
    await assert.rejects(provider.open(source, payload.length), ExecutionCancelled)
    assert.equal(loads, 2)
  } catch (error) { failures.push(error) }
  try {
    provider.dispose()
    const kernel = loaded.kernel
    if (kernel) { assert.equal(kernel.inspect().active, 0); assert.equal(kernel.inspect().allocatedBytes, 0) }
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Image provider work and cleanup failed', { cause: failures[0] })
})
