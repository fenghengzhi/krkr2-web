// Run with --expose-gc; verifies ownership of real Node Web Streams readers.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { deflateImage, inflateImage, inflateRaw } from '../../src/backends/files/blob-source.ts'
import { deflateRawSync } from 'node:zlib'
if (!global.gc) throw new Error('Run this probe with --expose-gc')
const references: WeakRef<object>[] = []
const original = ReadableStream.prototype.getReader
ReadableStream.prototype.getReader = function (
  this: ReadableStream,
  ...args: Parameters<typeof original>
) {
  const reader = Reflect.apply(original, this, args) as ReturnType<typeof original>
  references.push(new WeakRef(reader))
  return reader
} as typeof original
try {
  const input = Uint8Array.from({ length: 1024 }, (_, i) => i & 255)
  for (let i = 0; i < 64; i++) {
    const encoded = await deflateImage(input)
    assert.deepEqual(await inflateImage(encoded, input.length), input)
  }
  const encoded = await deflateImage(input)
  await assert.rejects(inflateImage(encoded, 1), /exceeds declared/)
  await assert.rejects(inflateImage(encoded, input.length + 1), /size mismatch/)
  await assert.rejects(inflateImage(encoded.subarray(0, encoded.length - 1), input.length))
  await assert.rejects(
    inflateRaw(deflateRawSync(input), input.length, async () => {
      throw new Error('Cancelled by checkpoint')
    }),
    /Cancelled by checkpoint/,
  )
} finally {
  ReadableStream.prototype.getReader = original
}
for (let i = 0; i < 6; i++) {
  await new Promise((resolve) => setTimeout(resolve, 0))
  global.gc()
}
const collected = references.filter((ref) => ref.deref() === undefined).length
assert(references.length >= 133)
assert.equal(collected, references.length)
const report = {
  date: new Date().toISOString(),
  readers: references.length,
  collected,
  roundTrips: 64,
  errorPaths: 4,
  scope:
    'Explicit V8 GC of real Node Web Streams readers after EOF, invalid size, truncated data and checkpoint cancellation; does not measure browser-native allocations.',
}
await writeFile(
  'out/verification/fonts/streams-lifetime.json',
  JSON.stringify(report, null, 2) + '\n',
)
console.log(JSON.stringify(report))
